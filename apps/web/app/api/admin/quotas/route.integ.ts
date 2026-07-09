// SPDX-License-Identifier: AGPL-3.0-or-later
import { quotaReport } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import { admin, useWorkspaceTable } from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

useWorkspaceTable("edd-admin-quotas-integ");

describe("GET /api/admin/quotas", () => {
  it("returns per-role limits + per-user usage (admin only)", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/quotas", { headers: admin("root") }),
    );
    expect(res.status).toBe(200);
    const report = quotaReport.parse(await res.json());
    // Every role has a limit entry (from config/env), and usage is an array.
    expect(report.limits.length).toBeGreaterThan(0);
    expect(report.limits.map((l) => l.role)).toContain("developer");
    expect(Array.isArray(report.usage)).toBe(true);
  });
});
