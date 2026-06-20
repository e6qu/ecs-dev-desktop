// SPDX-License-Identifier: AGPL-3.0-or-later
import { overviewReport } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import { admin, useWorkspaceTable } from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

useWorkspaceTable("edd-admin-overview-integ");

describe("GET /api/admin/overview", () => {
  it("returns fleet + catalog counts (admin only)", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/overview", { headers: admin("root") }),
    );
    expect(res.status).toBe(200);
    const report = overviewReport.parse(await res.json());
    expect(report.workspaces.total).toBeGreaterThanOrEqual(0);
    expect(report.baseImages.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.byState)).toBe(true);
  });
});
