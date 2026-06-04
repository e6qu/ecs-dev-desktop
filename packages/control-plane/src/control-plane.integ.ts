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
  pingTable,
} from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CatalogService,
  DerivedAuditSource,
  DerivedLogSource,
  HealthService,
  WorkspaceService,
} from "./index";

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

  it("inspect returns the full detail plus a derived timeline", async () => {
    const ws = await service.create({
      ownerId: ownerId("gina"),
      baseImage: baseImage("golden/node:20"),
    });
    const inspection = await service.inspect(workspaceId(ws.id));
    expect(inspection?.workspace.state).toBe("running");
    expect(inspection?.workspace.taskId).toBeDefined();
    expect(inspection?.workspace.volumeId).toBeDefined();
    expect(inspection?.timeline[0]?.event).toBe("created");
    expect(await service.inspect(workspaceId("ws-absent"))).toBeNull();
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

describe("HealthService (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("reports overall ok with a live DynamoDB ping and fake providers", async () => {
    const storage = await FakeStorageProvider.create();
    const health = new HealthService({
      storage,
      compute: new FakeComputeProvider(storage),
      pingDatabase: () => pingTable(client, TEST_TABLE),
      clock: fixedClock(),
    });

    const report = await health.report();
    expect(report.status).toBe("ok");
    const status = (name: string) => report.components.find((c) => c.component === name)?.status;
    expect(status("dynamodb")).toBe("ok"); // table is ACTIVE
    expect(status("control-plane")).toBe("ok");
    expect(status("reconciler")).toBe("unknown"); // no local run history
  });

  it("reports the database down when the table is missing", async () => {
    const storage = await FakeStorageProvider.create();
    const health = new HealthService({
      storage,
      compute: new FakeComputeProvider(storage),
      pingDatabase: () => pingTable(client, "ecs-dev-desktop-absent-table"),
      clock: fixedClock(),
    });
    const report = await health.report();
    const db = report.components.find((c) => c.component === "dynamodb");
    expect(db?.status).toBe("degraded"); // ResourceNotFound → degraded
  });
});

describe("DerivedAuditSource + DerivedLogSource (DynamoDB Local)", () => {
  let client: ReturnType<typeof createDynamoClient>;
  let workspaces: WorkspaceService;
  let entity: ReturnType<typeof makeWorkspaceEntity>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
  });

  beforeEach(async () => {
    const storage = await FakeStorageProvider.create();
    entity = makeWorkspaceEntity(client, TEST_TABLE);
    workspaces = new WorkspaceService({
      workspaces: entity,
      storage,
      compute: new FakeComputeProvider(storage),
      clock: fixedClock(),
    });
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  it("derives a fleet audit feed from the current workspace records", async () => {
    const ws = await workspaces.create({
      ownerId: ownerId("hank"),
      baseImage: baseImage("golden/node:20"),
    });
    const audit = new DerivedAuditSource({ workspaces: entity });
    const events = await audit.recent();
    const mine = events.filter((e) => e.target === ws.id);
    expect(mine.map((e) => e.action)).toContain("workspace.created");
    expect(mine.every((e) => e.actor === "system")).toBe(true);
  });

  it("serves the control-plane log stream and marks cloud-only streams unavailable", async () => {
    await workspaces.create({ ownerId: ownerId("ivy"), baseImage: baseImage("golden/node:20") });
    const logs = new DerivedLogSource({ audit: new DerivedAuditSource({ workspaces: entity }) });

    const cp = await logs.read("control-plane");
    expect(cp.available).toBe(true);
    expect(cp.lines.length).toBeGreaterThan(0);

    // Reconciler / container logs exist only once deployed (CloudWatch on AWS):
    // explicitly unavailable, never a silent empty.
    const container = await logs.read("container");
    expect(container.available).toBe(false);
    expect(container.lines).toHaveLength(0);
    expect(container.note).toMatch(/CloudWatch/);
  });
});
