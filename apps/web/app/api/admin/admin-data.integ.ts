// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive-path coverage for the admin data routes (the RBAC gate is covered by
// `admin-authz.integ.ts`): these assert the routes actually return real fleet data.
import {
  auditFeedResponse,
  healthReport,
  listWorkspacesResponse,
  logStreamResult,
  workspaceInspection,
} from "@edd/api-contracts";
import { describe, expect, it } from "vitest";

import {
  admin,
  createWorkspaceFor,
  useWorkspaceTable,
} from "../../../lib/test-support/workspace-route-harness";
import { GET as auditGet } from "./audit/route";
import { GET as healthGet } from "./health/route";
import { GET as logsGet } from "./logs/route";
import { GET as inspectGet } from "./workspaces/[id]/route";
import { GET as workspacesGet } from "./workspaces/route";

useWorkspaceTable("ecs-dev-desktop-web-admin-data-integ");

const ADMIN = "http://localhost/api/admin";
const asAdmin = (path: string) => new Request(`${ADMIN}/${path}`, { headers: admin("root") });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("admin data routes return real fleet data (DynamoDB Local)", () => {
  it("GET /api/admin/workspaces lists every member's workspace", async () => {
    const aliceWs = await createWorkspaceFor("alice");
    const bobWs = await createWorkspaceFor("bob");

    const res = await workspacesGet(asAdmin("workspaces"));
    expect(res.status).toBe(200);
    const { workspaces } = listWorkspacesResponse.parse(await res.json());
    const ids = workspaces.map((w) => w.id);
    expect(ids).toContain(aliceWs);
    expect(ids).toContain(bobWs);
    const owners = new Set(workspaces.map((w) => w.ownerId));
    expect(owners.has("alice") && owners.has("bob")).toBe(true);
  });

  it("GET /api/admin/workspaces/:id returns full detail + a derived timeline", async () => {
    const id = await createWorkspaceFor("carol");

    const res = await inspectGet(asAdmin(`workspaces/${id}`), params(id));
    expect(res.status).toBe(200);
    const inspection = workspaceInspection.parse(await res.json());
    expect(inspection.workspace.id).toBe(id);
    expect(inspection.workspace.state).toBe("running");
    expect(inspection.workspace.taskId).toBeDefined();
    expect(inspection.timeline.length).toBeGreaterThan(0);
  });

  it("GET /api/admin/workspaces/:id returns 404 for an unknown id", async () => {
    const res = await inspectGet(asAdmin("workspaces/no-such-id"), params("no-such-id"));
    expect(res.status).toBe(404);
  });

  it("GET /api/admin/health reports per-component status incl. a reachable database", async () => {
    const res = await healthGet(asAdmin("health"));
    expect(res.status).toBe(200);
    const report = healthReport.parse(await res.json());
    const database = report.components.find((c) => c.component === "dynamodb");
    expect(database?.status).toBe("ok");
  });

  it("GET /api/admin/audit derives audit events from current fleet state", async () => {
    const id = await createWorkspaceFor("dave");
    const res = await auditGet(asAdmin("audit"));
    expect(res.status).toBe(200);
    const { events } = auditFeedResponse.parse(await res.json());
    expect(events.some((e) => e.target === id && e.action === "workspace.created")).toBe(true);
  });

  it("GET /api/admin/logs?stream=control-plane returns the derived stream", async () => {
    const res = await logsGet(asAdmin("logs?stream=control-plane"));
    expect(res.status).toBe(200);
    const result = logStreamResult.parse(await res.json());
    expect(result.stream).toBe("control-plane");
    expect(result.available).toBe(true);
  });

  it("GET /api/admin/logs rejects an unknown stream (400)", async () => {
    expect((await logsGet(asAdmin("logs?stream=bogus"))).status).toBe(400);
  });
});
