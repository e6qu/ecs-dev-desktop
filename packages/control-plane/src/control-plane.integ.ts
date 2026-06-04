// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  baseImage,
  baseImageId,
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
  makeBaseImageEntity,
  makeWorkspaceEntity,
} from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CatalogService, WorkspaceService } from "./index";

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
    const storage = await FakeStorageProvider.create();
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
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

  it("connect wakes a scaled-to-zero workspace and is a no-op when already running", async () => {
    const ws = await service.create({
      ownerId: ownerId("erin"),
      baseImage: baseImage("golden/node:20"),
    });

    // Already running → connect returns it as-is (no restart, unlike start()).
    const ready = await service.connect(workspaceId(ws.id));
    expect(ready.state).toBe("running");

    await service.stop(workspaceId(ws.id));

    // Scaled to zero → connect wakes it from the snapshot.
    const woken = await service.connect(workspaceId(ws.id));
    expect(woken.state).toBe("running");
    expect(woken.id).toBe(ws.id);
  });

  it("heartbeat refreshes activity and rejects a stopped workspace", async () => {
    const ws = await service.create({
      ownerId: ownerId("frank"),
      baseImage: baseImage("golden/node:20"),
    });
    const beat = await service.heartbeat(workspaceId(ws.id));
    expect(beat.state).toBe("running");

    await service.stop(workspaceId(ws.id));
    await expect(service.heartbeat(workspaceId(ws.id))).rejects.toThrow();
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

describe("CatalogService (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let catalog: CatalogService;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  beforeEach(() => {
    catalog = new CatalogService({
      baseImages: makeBaseImageEntity(client, TEST_TABLE),
      clock: fixedClock(),
    });
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("creates → lists → gets → updates → removes a catalog entry", async () => {
    const created = await catalog.create({
      name: "Node 20",
      image: baseImage("golden/node:20"),
      description: "LTS",
    });
    expect(created).toMatchObject({ name: "Node 20", enabled: true });

    expect((await catalog.list()).map((e) => e.id)).toContain(created.id);
    expect((await catalog.get(baseImageId(created.id)))?.image).toBe("golden/node:20");

    const updated = await catalog.update(baseImageId(created.id), { enabled: false });
    expect(updated.enabled).toBe(false);

    await catalog.remove(baseImageId(created.id));
    expect(await catalog.get(baseImageId(created.id))).toBeNull();
  });

  it("assertEnabled passes only for an enabled catalog image", async () => {
    const entry = await catalog.create({ name: "Go", image: baseImage("golden/go:1.22") });
    await expect(catalog.assertEnabled(baseImage("golden/go:1.22"))).resolves.toBeUndefined();

    // Unknown image, and a disabled one, both fail.
    await expect(catalog.assertEnabled(baseImage("golden/rust:1"))).rejects.toThrow();
    await catalog.update(baseImageId(entry.id), { enabled: false });
    await expect(catalog.assertEnabled(baseImage("golden/go:1.22"))).rejects.toThrow();
  });
});
