// SPDX-License-Identifier: AGPL-3.0-or-later
import { configSyncReport } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import { admin, useWorkspaceTable } from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * The config-sync route against DynamoDB Local. Under the in-process fakes (no real
 * AWS identity), the IAM preflight self-reports `unknown` rather than a false drift,
 * and no caller identity is surfaced — the route still returns a valid report.
 */
useWorkspaceTable("edd-config-sync-integ");

describe("GET /api/admin/config-sync", () => {
  it("returns a valid report with an IAM-permissions check (unknown under fakes)", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/config-sync", { headers: admin("root") }),
    );
    expect(res.status).toBe(200);
    const report = configSyncReport.parse(await res.json());

    const iam = report.checks.find((c) => c.name === "iam-permissions:control-plane");
    expect(iam, "the IAM-permissions check is present").toBeDefined();
    expect(iam?.status).toBe("unknown"); // no real identity in the fakes harness
    // The DynamoDB live check resolves ok against DynamoDB Local.
    expect(report.checks.find((c) => c.name === "dynamodb")?.status).toBe("ok");
    // No caller identity is surfaced off real AWS.
    expect(report.identity).toBeUndefined();
  });
});
