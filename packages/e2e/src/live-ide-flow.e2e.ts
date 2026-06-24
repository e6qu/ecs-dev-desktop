// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { deriveWorkspaceToken } from "@edd/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startIdeBridge, type IdeBridge } from "./ide-bridge";
import {
  createRunningWorkspace,
  initLiveEnv,
  newSecret,
  startEditorApp,
  WORKSPACE_IMAGE,
  type LiveEcsApp,
} from "./live-editor-fixture";

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
initLiveEnv();

const RUN_ID = randomUUID().slice(0, 8);
const OWNER = "ide-user";
// Master key for the editor connection token. With it set, the control plane injects
// each task's CONNECTION_TOKEN = HMAC(secret, workspaceId) — the same value the in-app
// proxy would hand the browser. The bridge then reads the token the running editor
// actually uses, so we can assert the injection end to end.
const CONNECTION_SECRET = newSecret();

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
      // Distinct CIDRs from the other live suites so concurrent runs never collide.
      app = await startEditorApp({
        runId: `ide-${RUN_ID}`,
        vpcCidr: "10.80.0.0/16",
        subnetCidr: "10.80.1.0/24",
        connectionSecret: CONNECTION_SECRET,
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
      const ws = await createRunningWorkspace(app, OWNER);

      // Bridge into the task's isolated netns and reach the workbench.
      bridge = await startIdeBridge({ workspaceId: ws.id, image: WORKSPACE_IMAGE });

      // The token the running editor actually uses (read from its --connection-token
      // process arg) is exactly the per-workspace token the control plane injected as
      // CONNECTION_TOKEN — i.e. the value the in-app proxy hands the browser. This is
      // the editor-connection-token handoff proven against real sim compute.
      expect(bridge.token).toBe(deriveWorkspaceToken(CONNECTION_SECRET, ws.id));

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
