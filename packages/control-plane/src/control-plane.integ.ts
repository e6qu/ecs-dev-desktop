// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  baseImage,
  FakeComputeProvider,
  FakeStorageProvider,
  fixedClock,
  ownerId,
  workspaceId,
} from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodbLocal,
  ensureTable,
  makeWorkspaceEntity,
} from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const TEST_TABLE = "ecs-dev-desktop-cp-integ";

describe("WorkspaceService lifecycle (DynamoDB Local + fakes)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  beforeEach(async () => {
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage: await FakeStorageProvider.create(),
      compute: new FakeComputeProvider(),
      clock: fixedClock(),
    });
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("create → list → get", async () => {
    const ws = await service.create({
      ownerId: ownerId("alice"),
      baseImage: baseImage("golden/node:20"),
    });
    expect(ws.state).toBe("running");

    const mine = await service.list({ ownerId: ownerId("alice") });
    expect(mine.map((w) => w.id)).toContain(ws.id);

    const got = await service.get(workspaceId(ws.id));
    expect(got?.ownerId).toBe("alice");
  });

  it("round-trips state through stop (snapshot) → start (hydrate)", async () => {
    const ws = await service.create({
      ownerId: ownerId("bob"),
      baseImage: baseImage("golden/go:1.22"),
    });

    const stopped = await service.stop(workspaceId(ws.id));
    expect(stopped.state).toBe("stopped");

    const started = await service.start(workspaceId(ws.id));
    expect(started.state).toBe("running");
  });

  it("rejects an invalid transition (start while running)", async () => {
    const ws = await service.create({ ownerId: ownerId("carol"), baseImage: baseImage("img") });
    await expect(service.start(workspaceId(ws.id))).rejects.toThrow();
  });

  it("removes a workspace", async () => {
    const ws = await service.create({ ownerId: ownerId("dave"), baseImage: baseImage("img") });
    await service.remove(workspaceId(ws.id));
    expect(await service.get(workspaceId(ws.id))).toBeNull();
  });
});
