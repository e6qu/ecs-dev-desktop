// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiBase,
  createWorkspaceFor,
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { AGENT_SECRET_ENV } from "../../../../../lib/constants";
import { POST as stop } from "../stop/route";
import { POST as heartbeat } from "./route";

useWorkspaceTable("ecs-dev-desktop-web-heartbeat-integ");

const TEST_SECRET = "a".repeat(64); // 32 bytes hex

function agentToken(wsId: string): string {
  return createHmac("sha256", Buffer.from(TEST_SECRET, "hex")).update(wsId).digest("hex");
}

function beat(actor: string, id: string): Promise<Response> {
  return heartbeat(
    new Request(`${apiBase}/${id}/heartbeat`, { method: "POST", headers: member(actor) }),
    routeCtx(id),
  );
}

function agentBeat(id: string, token?: string): Promise<Response> {
  return heartbeat(
    new Request(`${apiBase}/${id}/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? agentToken(id)}` },
    }),
    routeCtx(id),
  );
}

describe("POST /api/workspaces/:id/heartbeat (DynamoDB Local)", () => {
  it("accepts a heartbeat on a running workspace (200)", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await beat("alice", id)).status).toBe(200);
  });

  it("rejects a heartbeat on a stopped workspace (409, not 500)", async () => {
    const id = await createWorkspaceFor("alice");
    expect(
      (
        await stop(
          new Request(`${apiBase}/${id}/stop`, { method: "POST", headers: member("alice") }),
          routeCtx(id),
        )
      ).status,
    ).toBe(200);
    // markActivity returns a `conflict` DomainError while the workspace is 'stopped';
    // the route's central mapper turns that into 409 — it never escapes as a 500.
    const res = await beat("alice", id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/stopped/);
  });

  it("forbids heartbeating another member's workspace (403)", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await beat("bob", id)).status).toBe(403);
  });

  describe("agent machine-auth", () => {
    beforeEach(() => {
      vi.stubEnv(AGENT_SECRET_ENV, TEST_SECRET);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // Each test uses a distinct owner to avoid hitting the 5-workspace member quota
    // shared across the whole suite (outer tests already consume 3 of alice's slots).
    it("accepts a valid agent token (200)", async () => {
      const id = await createWorkspaceFor("agent-user-1");
      expect((await agentBeat(id)).status).toBe(200);
    });

    it("rejects a wrong agent token (401)", async () => {
      const id = await createWorkspaceFor("agent-user-2");
      expect((await agentBeat(id, "deadbeef")).status).toBe(401);
    });

    it("rejects when EDD_AGENT_SECRET is unset (401)", async () => {
      vi.stubEnv(AGENT_SECRET_ENV, "");
      const id = await createWorkspaceFor("agent-user-3");
      expect((await agentBeat(id)).status).toBe(401);
    });

    it("accepts a heartbeat carrying a functional self-report (200)", async () => {
      const id = await createWorkspaceFor("agent-user-4");
      const res = await heartbeat(
        new Request(`${apiBase}/${id}/heartbeat`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${agentToken(id)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ functional: { ide: true, workspace: true } }),
        }),
        routeCtx(id),
      );
      expect(res.status).toBe(200);
    });

    it("returns 404 for an unknown workspace id", async () => {
      expect((await agentBeat("ws-does-not-exist")).status).toBe(404);
    });
  });
});
