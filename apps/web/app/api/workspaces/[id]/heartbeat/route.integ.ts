// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  apiBase,
  createWorkspaceFor,
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { POST as stop } from "../stop/route";
import { POST as heartbeat } from "./route";

useWorkspaceTable("ecs-dev-desktop-web-heartbeat-integ");

function beat(actor: string, id: string): Promise<Response> {
  return heartbeat(
    new Request(`${apiBase}/${id}/heartbeat`, { method: "POST", headers: member(actor) }),
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
});
