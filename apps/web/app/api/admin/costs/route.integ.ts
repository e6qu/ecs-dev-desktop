// SPDX-License-Identifier: AGPL-3.0-or-later
import { auditFeedResponse, costReport } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import {
  admin,
  createWorkspaceFor,
  stopWorkspaceFor,
  useWorkspaceTable,
} from "../../../../lib/test-support/workspace-route-harness";
import { GET as auditFeed } from "../audit/route";
import { GET } from "./route";

/**
 * The admin cost report against DynamoDB Local. A workspace created then stopped
 * through the real routes shows up as a priced session — exercising the full
 * path: the control plane records `session.create`/`session.stop` to the ledger
 * (the centralized lifecycle audit), and the cost service prices that ledger.
 */
useWorkspaceTable("edd-cost-report-integ");

const costs = () =>
  GET(new Request("http://localhost/api/admin/costs", { headers: admin("root") }));

describe("admin cost report", () => {
  it("prices a created-then-stopped session and rolls it up per user", async () => {
    const id = await createWorkspaceFor("alice");
    await stopWorkspaceFor(id);

    const res = await costs();
    expect(res.status).toBe(200);
    const report = costReport.parse(await res.json());

    const session = report.bySession.find((s) => s.workspaceId === id);
    expect(session, "the created workspace appears as a cost line").toBeDefined();
    expect(session?.owner).toBe("alice"); // dev-auth: actor = id (no email)
    expect(session?.state).toBe("stopped");
    expect(session?.totalUsd).toBeGreaterThanOrEqual(0);

    const user = report.byUser.find((u) => u.owner === "alice");
    expect(user, "alice is rolled up in the per-user view").toBeDefined();
    expect(report.total.totalUsd).toBeGreaterThanOrEqual(0);
  });

  it("records the stop on the ledger via the control plane (no route-level emit)", async () => {
    const id = await createWorkspaceFor("bob");
    await stopWorkspaceFor(id, "bob");

    const res = await auditFeed(
      new Request("http://localhost/api/admin/audit", { headers: admin("root") }),
    );
    const { events } = auditFeedResponse.parse(await res.json());
    expect(events.some((e) => e.action === "session.create" && e.target === id)).toBe(true);
    const stop = events.find((e) => e.action === "session.stop" && e.target === id);
    expect(stop, "session.stop recorded by the control plane").toBeDefined();
    expect(stop?.actor).toBe("bob");
  });

  it("scopes the report to a time window via ?window= (last 24h includes a just-run session)", async () => {
    const id = await createWorkspaceFor("dana");
    await stopWorkspaceFor(id);

    const res = await GET(
      new Request("http://localhost/api/admin/costs?window=1d", { headers: admin("root") }),
    );
    expect(res.status).toBe(200);
    const report = costReport.parse(await res.json());
    // The session ran just now, so it is inside the 24h window.
    expect(report.bySession.some((s) => s.workspaceId === id)).toBe(true);
    // windowStart is exactly now - 1 day (not the ledger start) — window in effect.
    const dayMs = 24 * 60 * 60 * 1000;
    expect(Date.parse(report.generatedAt) - Date.parse(report.windowStart)).toBe(dayMs);
  });

  it("rejects a garbage ?window= value with 400 (not a silent lifetime report)", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/costs?window=bogus", { headers: admin("root") }),
    );
    // costReportQuery uses `.default("all")`, so an absent param defaults but an
    // explicit invalid value fails validation → the route returns 400 at the boundary
    // instead of silently showing lifetime cost (the prior `.catch("all")` swallowed it).
    expect(res.status).toBe(400);
  });

  it("defaults an absent ?window= to the full lifetime (200)", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/costs", { headers: admin("root") }),
    );
    expect(res.status).toBe(200);
  });

  it("denies non-admins", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/costs", {
        headers: { "x-edd-user-id": "m", "x-edd-role": "member" },
      }),
    );
    expect(res.status).toBe(403);
  });
});
