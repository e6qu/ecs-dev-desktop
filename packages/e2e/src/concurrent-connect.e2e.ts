// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { ListTasksCommand } from "@aws-sdk/client-ecs";
import { workspace, workspaceInspection } from "@edd/api-contracts";
import { dynamodb } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureAwsSimEnv, e2eWorkspaceImage, required, sleep } from "./aws-sim";
import { startLiveEcsApp, type LiveEcsApp } from "./live-ecs-app";
import { devHeaders } from "./web-app";

/**
 * Concurrent wake-on-connect race e2e: N simultaneous POST /connect on a
 * STOPPED workspace, against the REAL control plane and REAL sim compute.
 *
 * The wake path is read → validate → RunTask → persist. Without conditional
 * persistence, every racer that read "stopped" launches its own real ECS task
 * and the last write wins — the losers' tasks leak forever (nothing references
 * them; GC reaps storage only). Concurrent connects are NORMAL in production:
 * the SSH gateway calls /connect per connection, and the portal Start button
 * races it. This test asserts exactly one task survives and every racer gets
 * an idempotent 200.
 */

configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const WORKSPACE_IMAGE = e2eWorkspaceImage();
const AGENT_SECRET = "a1".repeat(32);
const OWNER = "race-user";
const RACERS = 5;

describe(
  "concurrent wake-on-connect race (real CP + container-mode sim)",
  { timeout: 600_000 },
  () => {
    let app: LiveEcsApp;
    let wsId = "";

    async function api(path: string, init?: RequestInit): Promise<Response> {
      return fetch(`${app.web.baseUrl}/api${path}`, {
        headers: devHeaders(OWNER, "member"),
        ...init,
      });
    }

    async function runningTaskArns(): Promise<string[]> {
      const out = await app.ecs.send(
        new ListTasksCommand({ cluster: app.cluster, desiredStatus: "RUNNING" }),
      );
      return out.taskArns ?? [];
    }

    beforeAll(async () => {
      app = await startLiveEcsApp({
        runId: RUN_ID,
        workspaceImage: WORKSPACE_IMAGE,
        vpcCidr: "10.74.0.0/16",
        subnetCidr: "10.74.1.0/24",
        agentSecret: AGENT_SECRET,
      });
    });

    afterAll(async () => {
      await app.stop();
    });

    it("exactly one task survives N concurrent connects; every racer gets an idempotent 200", async () => {
      // Create the workspace under test. A first RunTask can transiently 5xx
      // on the shared sim under multi-suite load (the same class the e2e
      // harness retries elsewhere); retry the SETUP create so an environmental
      // blip never masks the race assertion below. The race itself is strict.
      let created = await api("/workspaces", {
        method: "POST",
        body: JSON.stringify({ baseImage: WORKSPACE_IMAGE }),
      });
      for (let attempt = 0; created.status >= 500 && attempt < 3; attempt++) {
        await sleep(3_000);
        created = await api("/workspaces", {
          method: "POST",
          body: JSON.stringify({ baseImage: WORKSPACE_IMAGE }),
        });
      }
      expect(created.status).toBe(201);
      wsId = workspace.parse(await created.json()).id;
      expect((await api(`/workspaces/${wsId}/stop`, { method: "POST" })).status).toBe(200);

      // Let the first task fully stop so RUNNING-task counting is unambiguous.
      const settleDeadline = Date.now() + 120_000;
      while ((await runningTaskArns()).length > 0) {
        if (Date.now() > settleDeadline) throw new Error("initial task never stopped");
        await sleep(2_000);
      }

      // Fire the racers simultaneously.
      const results = await Promise.all(
        Array.from({ length: RACERS }, () =>
          api(`/workspaces/${wsId}/connect`, { method: "POST" }),
        ),
      );
      for (const res of results) {
        expect(
          res.status,
          `connect must be idempotent under contention: ${await res.clone().text()}`,
        ).toBe(200);
        expect(workspace.parse(await res.json()).state).toBe("running");
      }

      // The persisted record is the source of truth for the winner: exactly one
      // connect's task is committed; the losers compensated theirs.
      const inspectRes = await fetch(`${app.web.baseUrl}/api/admin/workspaces/${wsId}`, {
        headers: devHeaders("root", "admin"),
      });
      const detail = workspaceInspection.parse(await inspectRes.json()).workspace;
      expect(detail.state).toBe("running");
      const winner = required(detail.taskId, "winning task arn");

      // The invariant under test is NO LEAK: every losing connect compensated
      // the task it launched, so no task OTHER than the committed winner is left
      // with desired-status RUNNING. (Whether the winner's golden-image
      // container itself reaches RUNNING under 5× concurrent launches is a
      // workspace-health property covered non-concurrently by user-journey /
      // golden-workspace-ssh; coupling to it here would make the race test flaky
      // on a load-constrained sim.) ListTasks is eventually consistent, so poll
      // until the losers' stops drain.
      const deadline = Date.now() + 120_000;
      for (;;) {
        const leaked = (await runningTaskArns()).filter((arn) => arn !== winner);
        if (leaked.length === 0) break;
        if (Date.now() > deadline) {
          throw new Error(`concurrent connects leaked tasks: ${JSON.stringify(leaked)}`);
        }
        await sleep(2_000);
      }
    });
  },
);
