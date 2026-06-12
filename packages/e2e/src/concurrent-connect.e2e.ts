// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DescribeTasksCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { workspace, workspaceInspection } from "@edd/api-contracts";
import { dynamodbLocal } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureAwsSimEnv, required, sleep } from "./aws-sim";
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
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const AGENT_SECRET = "a1".repeat(32);
const OWNER = "race-user";
const RACERS = 5;
const SSH_CA_DIR = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca");

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
        sshCaPublicKey: readFileSync(join(SSH_CA_DIR, "ca.pub"), "utf8").trim(),
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

      // Losers' compensations may still be draining; wait for steady state.
      const deadline = Date.now() + 120_000;
      let running = await runningTaskArns();
      while (running.length > 1 && Date.now() < deadline) {
        await sleep(2_000);
        running = await runningTaskArns();
      }
      expect(running, "concurrent connects must not leak ECS tasks").toHaveLength(1);
      const survivor = required(running[0], "surviving task arn");

      // The persisted record points at the surviving task.
      const inspectRes = await fetch(`${app.web.baseUrl}/api/admin/workspaces/${wsId}`, {
        headers: devHeaders("root", "admin"),
      });
      const detail = workspaceInspection.parse(await inspectRes.json()).workspace;
      expect(detail.state).toBe("running");
      expect(detail.taskId).toBe(survivor);

      // And the survivor genuinely reaches RUNNING per the cloud API.
      const runDeadline = Date.now() + 120_000;
      for (;;) {
        const described = await app.ecs.send(
          new DescribeTasksCommand({ cluster: app.cluster, tasks: [survivor] }),
        );
        const status = required(described.tasks?.[0]?.lastStatus, "lastStatus");
        if (status === "RUNNING") break;
        if (status === "STOPPED" || Date.now() > runDeadline) {
          throw new Error(`surviving task never reached RUNNING (last: ${status})`);
        }
        await sleep(2_000);
      }
    });
  },
);
