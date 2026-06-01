// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixedClock, FakeComputeProvider, FakeStorageProvider } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceService } from "./index";

process.env.DYNAMODB_ENDPOINT ??= "http://localhost:8000";

const TEST_TABLE = "ecs-dev-desktop-cp-integ";

describe("WorkspaceService lifecycle (DynamoDB Local + fakes)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let storage: FakeStorageProvider;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  beforeEach(async () => {
    storage = await FakeStorageProvider.create();
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage,
      compute: new FakeComputeProvider(),
      clock: fixedClock(),
    });
  });

  afterAll(async () => {
    if (client) await dropTable(client, TEST_TABLE);
  });

  it("create → list → get", async () => {
    const ws = await service.create({ ownerId: "alice", baseImage: "golden/node:20" });
    expect(ws.state).toBe("running");

    const mine = await service.list({ ownerId: "alice" });
    expect(mine.map((w) => w.id)).toContain(ws.id);

    const got = await service.get(ws.id);
    expect(got?.ownerId).toBe("alice");
  });

  it("round-trips state through stop (snapshot) → start (hydrate)", async () => {
    const ws = await service.create({ ownerId: "bob", baseImage: "golden/go:1.22" });

    const stopped = await service.stop(ws.id);
    expect(stopped.state).toBe("stopped");

    const started = await service.start(ws.id);
    expect(started.state).toBe("running");
  });

  it("rejects an invalid transition (start while running)", async () => {
    const ws = await service.create({ ownerId: "carol", baseImage: "img" });
    await expect(service.start(ws.id)).rejects.toThrow();
  });

  it("removes a workspace", async () => {
    const ws = await service.create({ ownerId: "dave", baseImage: "img" });
    await service.remove(ws.id);
    expect(await service.get(ws.id)).toBeNull();
  });
});
