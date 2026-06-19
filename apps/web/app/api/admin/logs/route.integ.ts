// SPDX-License-Identifier: AGPL-3.0-or-later
import { logStreamResult } from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import { admin, useWorkspaceTable } from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * The admin logs route against DynamoDB Local. The key guarantee: a `workspaceId`
 * filter that can't be resolved must NOT silently fall through to the unfiltered
 * (all-container) stream — that would leak every workspace's logs to a typo'd id.
 */
useWorkspaceTable("edd-admin-logs-integ");

const url = (qs: string): Request =>
  new Request(`http://localhost/api/admin/logs?${qs}`, { headers: admin("root") });

describe("GET /api/admin/logs", () => {
  it("returns the control-plane stream without a workspace filter (200)", async () => {
    const res = await GET(url("stream=control-plane"));
    expect(res.status).toBe(200);
    expect(logStreamResult.parse(await res.json()).stream).toBe("control-plane");
  });

  it("404s a container request for an unknown workspaceId (never the unfiltered stream)", async () => {
    const res = await GET(url("stream=container&workspaceId=ws-does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("rejects an unknown stream (400)", async () => {
    expect((await GET(url("stream=bogus"))).status).toBe(400);
  });
});
