// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { makeWorkspaceEntity, createDynamoClient } from "@edd/db";
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  ownerId,
  systemClock,
  workspaceId,
} from "@edd/core";
import { WorkspaceService } from "@edd/control-plane";
import { sshConnectInfo } from "@edd/api-contracts";

import {
  apiBase,
  createWorkspaceFor,
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

const TABLE = "ecs-dev-desktop-web-connect-info-integ";
useWorkspaceTable(TABLE);

function get(actor: string, id: string): Promise<Response> {
  return GET(
    new Request(`${apiBase}/${id}/connect-info`, { headers: member(actor) }),
    routeCtx(id),
  );
}

async function makeService(sshHost?: string): Promise<WorkspaceService> {
  const storage = await FakeStorageProvider.create();
  const compute = new FakeComputeProvider(storage, sshHost !== undefined ? { sshHost } : {});
  const client = createDynamoClient();
  return new WorkspaceService({
    workspaces: makeWorkspaceEntity(client, TABLE),
    storage,
    compute,
    clock: systemClock,
  });
}

describe("GET /api/workspaces/:id/connect-info (DynamoDB Local)", () => {
  it("returns 200 with host:port for a running workspace that has an sshHost", async () => {
    const service = await makeService("10.0.1.42");
    const ws = await service.create({
      ownerId: ownerId("alice"),
      baseImage: baseImage("golden/node:20"),
    });

    const res = await get("alice", ws.id);
    expect(res.status).toBe(200);
    const body = sshConnectInfo.parse(await res.json());
    expect(body.host).toBe("10.0.1.42");
    expect(body.port).toBe(22);
  });

  it("returns 409 when the workspace is stopped (no running task)", async () => {
    const service = await makeService("192.168.1.10");
    const ws = await service.create({
      ownerId: ownerId("alice"),
      baseImage: baseImage("golden/node:20"),
    });
    await service.stop(workspaceId(ws.id));

    const res = await get("alice", ws.id);
    expect(res.status).toBe(409);
  });

  it("returns 404 when workspace is running but has no sshHost", async () => {
    const service = await makeService();
    const ws = await service.create({
      ownerId: ownerId("alice"),
      baseImage: baseImage("golden/node:20"),
    });

    const res = await get("alice", ws.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await get("alice", "no-such-id");
    expect(res.status).toBe(404);
  });

  it("returns 403 for another member's workspace", async () => {
    const id = await createWorkspaceFor("alice");
    const res = await get("bob", id);
    expect(res.status).toBe(403);
  });
});
