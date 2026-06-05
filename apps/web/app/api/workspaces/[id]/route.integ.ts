// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  apiBase,
  createWorkspaceFor,
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../../lib/test-support/workspace-route-harness";
import { DELETE } from "./route";

useWorkspaceTable("ecs-dev-desktop-web-id-integ");

function del(actor: string, id: string): Promise<Response> {
  return DELETE(
    new Request(`${apiBase}/${id}`, { method: "DELETE", headers: member(actor) }),
    routeCtx(id),
  );
}

describe("DELETE /api/workspaces/:id (DynamoDB Local)", () => {
  it("deletes an owned workspace (204)", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await del("alice", id)).status).toBe(204);
  });

  it("returns 404 (not 500) on a repeated delete", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await del("alice", id)).status).toBe(204);
    // A sequential repeat hits the not-found guard (404). The *concurrent* race —
    // where both requests pass the guard and the second's re-fetch in cp.remove
    // yields a not_found Result — is mapped to 404 by the central mapper too, so
    // neither path can escape as a 500.
    expect((await del("alice", id)).status).toBe(404);
  });

  it("forbids deleting another member's workspace (403)", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await del("bob", id)).status).toBe(403);
  });
});
