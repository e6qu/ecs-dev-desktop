// SPDX-License-Identifier: AGPL-3.0-or-later
import { auditFeedResponse } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import {
  admin,
  createWorkspaceFor,
  useWorkspaceTable,
} from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * The admin audit feed against DynamoDB Local: a session created through the real
 * route emits a first-class, actor-attributed `session.create` event, which the
 * feed returns (merged with the derived lifecycle feed), newest-first.
 */
useWorkspaceTable("edd-audit-feed-integ");

const feed = () => GET(new Request("http://localhost/api/admin/audit", { headers: admin("root") }));

describe("admin audit feed (first-class events)", () => {
  it("records session.create through the route and shows it, actor-attributed", async () => {
    const id = await createWorkspaceFor("audit-user");
    const res = await feed();
    expect(res.status).toBe(200);
    const { events } = auditFeedResponse.parse(await res.json());

    const created = events.find((e) => e.action === "session.create" && e.target === id);
    expect(created, "session.create event for the new workspace").toBeDefined();
    expect(created?.actor).toBe("audit-user"); // dev-auth: actor = id (no email)

    // The derived lifecycle feed is merged in too (workspace.* from state).
    expect(events.some((e) => e.action.startsWith("workspace."))).toBe(true);
    // Newest-first ordering.
    const ats = events.map((e) => e.at);
    expect([...ats].sort((a, b) => b.localeCompare(a))).toEqual(ats);
  });

  it("denies non-admins", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/audit", {
        headers: { "x-edd-user-id": "m", "x-edd-role": "member" },
      }),
    );
    expect(res.status).toBe(403);
  });
});
