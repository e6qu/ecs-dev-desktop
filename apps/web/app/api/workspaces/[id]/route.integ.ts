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
  it("accepts a delete request (202 — async tombstone)", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await del("alice", id)).status).toBe(202);
  });

  it("is idempotent: a repeated delete is accepted (202, not 500), not a 404", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await del("alice", id)).status).toBe(202);
    // The first delete moves the workspace to the `deleting` tombstone (the record
    // persists until the reconciler finishes teardown), so a repeat is idempotent —
    // remove() returns ok and the route 202s again, rather than racing to a 404/500.
    expect((await del("alice", id)).status).toBe(202);
  });

  it("forbids deleting another member's workspace (403)", async () => {
    const id = await createWorkspaceFor("alice");
    expect((await del("bob", id)).status).toBe(403);
  });
});
