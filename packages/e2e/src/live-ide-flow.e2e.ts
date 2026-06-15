// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workspace } from "@edd/api-contracts";
import { dynamodb } from "@edd/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureAwsSimEnv } from "./aws-sim";
import { startIdeBridge, type IdeBridge } from "./ide-bridge";
import { startLiveEcsApp, type LiveEcsApp } from "./live-ecs-app";
import { devHeaders } from "./web-app";

/**
 * Full live flow on the container-mode sim: the REAL control plane launches a
 * workspace as a REAL ECS task (managed EBS + awsvpc ENI) on a REAL cluster, and
 * the actual OpenVSCode workbench is reached in a browser-equivalent fetch through
 * the IDE bridge (host → `docker exec` → the task netns → :3000). This proves the
 * end-to-end "create a workspace and open its IDE" path, not just the lifecycle.
 *
 * Endpoint/coordinate-only (§6.8/§6.9): only AWS endpoint+credentials differ from
 * real cloud; the bridge is the local/sim realisation of the production proxy reach.
 */
configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE ?? "edd-workspace:e2e";
const OWNER = "ide-user";

/** Throwaway ed25519 CA public key — the workspace entrypoint requires
 * EDD_SSH_CA_PUBLIC_KEY to configure sshd (this flow exercises the HTTP IDE). */
function genCaPublicKey(): string {
  const dir = mkdtempSync(join(tmpdir(), "edd-ideflow-ca-"));
  const key = join(dir, "ca");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key, "-C", "edd-ideflow-ca"]);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();
  rmSync(dir, { recursive: true, force: true });
  return pub;
}

/** Follow OpenVSCode's token redirect with a cookie jar (node fetch has none):
 * `/?tkn=` → 302 (Set-Cookie) → GET the workbench with that cookie. */
async function fetchWorkbench(bridge: IdeBridge): Promise<{ status: number; body: string }> {
  const first = await fetch(bridge.url, { redirect: "manual" });
  if (first.status === 200) return { status: 200, body: await first.text() };
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const location = first.headers.get("location") ?? "/";
  const followed = await fetch(new URL(location, bridge.url), { headers: { cookie } });
  return { status: followed.status, body: await followed.text() };
}

describe(
  "full live flow: create a workspace and open its real IDE through the cluster",
  { timeout: 600_000 },
  () => {
    let app: LiveEcsApp | undefined;
    let bridge: IdeBridge | undefined;

    beforeAll(async () => {
      app = await startLiveEcsApp({
        runId: `ide-${RUN_ID}`,
        workspaceImage: WORKSPACE_IMAGE,
        // Distinct CIDRs from the other live suites so concurrent runs never collide.
        vpcCidr: "10.80.0.0/16",
        subnetCidr: "10.80.1.0/24",
        agentSecret: randomBytes(32).toString("hex"),
        sshCaPublicKey: genCaPublicKey(),
      });
    });

    afterAll(async () => {
      bridge?.close();
      // Guard: if beforeAll failed, `app` is undefined — surface that root cause
      // rather than a teardown TypeError.
      await app?.stop();
    });

    it("launches a real ECS task and serves the OpenVSCode workbench through the bridge", async () => {
      if (app === undefined) throw new Error("app was not started (beforeAll failed)");
      // Create the workspace through the real HTTP API (real RunTask + readiness gate).
      const created = await fetch(`${app.web.baseUrl}/api/workspaces`, {
        method: "POST",
        headers: devHeaders(OWNER, "member"),
        body: JSON.stringify({ baseImage: WORKSPACE_IMAGE }),
      });
      expect(created.status).toBe(201);
      const ws = workspace.parse(await created.json());
      expect(ws.state).toBe("running");

      // Bridge into the task's isolated netns and reach the workbench.
      bridge = await startIdeBridge({ workspaceId: ws.id, image: WORKSPACE_IMAGE });

      // Without the connection token the server gates the request (proves it's the
      // real OpenVSCode auth, not an open port).
      const gated = await fetch(`http://127.0.0.1:${String(bridge.port)}/`, { redirect: "manual" });
      expect(gated.status).toBe(403);

      // With the token (extracted from the running task), the real workbench serves.
      const wb = await fetchWorkbench(bridge);
      expect(wb.status).toBe(200);
      expect(wb.body).toContain("vscode-workbench-web-configuration");
      expect(wb.body).toContain(`127.0.0.1:${String(bridge.port)}`); // remoteAuthority points back through the bridge
    });
  },
);
