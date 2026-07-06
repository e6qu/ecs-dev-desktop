// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  baseImage,
  baseImageId,
  FakeComputeProvider,
  FakeStorageProvider,
  fixedClock,
  InMemoryMetricSink,
  METRIC_SECURITY_PRIVILEGE_ATTEMPT,
  METRIC_WORKSPACE_WAKE_LATENCY_MS,
  ownerId,
  unwrap,
  workspaceId,
  type Clock,
  type ComputeProvider,
  type ComputeTask,
  type RunTaskInput,
  type TaskId,
  type TaskLiveness,
} from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodb,
  ensureTable,
  makeAuditEventEntity,
  makeBaseImageEntity,
  makeOwnerWorkspaceCountEntity,
  makeWorkspaceEntity,
  pingTable,
} from "@edd/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CatalogService,
  ComputeUnavailableError,
  DerivedAuditSource,
  DerivedLogSource,
  HealthService,
  QuotaExceededError,
  WorkspaceService,
} from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodb.endpoint;

/** A compute provider whose launch always fails — to exercise the
 * compute-unavailable (503/handled) path without an unexpected throw. */
class FailingCompute implements ComputeProvider {
  runTask(_input: RunTaskInput): Promise<ComputeTask> {
    return Promise.reject(new Error("Cluster not found: edd-workspaces"));
  }
  stopTask(_taskId: TaskId): Promise<void> {
    return Promise.resolve();
  }
  taskState(_taskId: TaskId): Promise<TaskLiveness> {
    return Promise.resolve("stopped");
  }
}

const TEST_TABLE = "ecs-dev-desktop-cp-integ";

describe("WorkspaceService lifecycle ", () => {
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

    const stopped = unwrap(await service.stop(workspaceId(ws.id)));
    expect(stopped.state).toBe("stopped");

    const started = unwrap(await service.start(workspaceId(ws.id)));
    expect(started.state).toBe("running");
  });

  it("emits a wake cold-start latency metric on start()", async () => {
    // A deterministic clock that advances a fixed step per read, so the wake
    // latency (clock reads spanning the start path) is a stable positive number.
    let tMs = Date.parse("2026-06-01T00:00:00.000Z");
    const advancing: Clock = {
      now: () => {
        const iso = new Date(tMs).toISOString();
        tMs += 1000;
        return iso;
      },
    };
    const metrics = new InMemoryMetricSink();
    const storage = await FakeStorageProvider.create();
    const svc = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
      clock: advancing,
      metrics,
    });

    const ws = await svc.create({
      ownerId: ownerId("wake-metric"),
      baseImage: baseImage("golden/node:20"),
    });
    unwrap(await svc.stop(workspaceId(ws.id)));
    metrics.recorded.length = 0; // only assert on the wake below
    unwrap(await svc.start(workspaceId(ws.id)));

    const wake = metrics.recorded.find((m) => m.name === METRIC_WORKSPACE_WAKE_LATENCY_MS);
    expect(wake?.kind).toBe("timing");
    expect(wake?.value).toBeGreaterThan(0);
    expect(wake?.dimensions).toMatchObject({ baseImage: "golden/node:20" });
  });

  it("surfaces a compute-launch failure as handled unavailable, never an unexpected throw", async () => {
    const failing = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage: await FakeStorageProvider.create(),
      compute: new FailingCompute(),
      clock: fixedClock(),
    });

    // create(): a launch failure is thrown as a typed ComputeUnavailableError (the
    // route maps it to 503), not a raw error — and no record is left behind.
    await expect(
      failing.create({ ownerId: ownerId("noecs"), baseImage: baseImage("golden/node:20") }),
    ).rejects.toBeInstanceOf(ComputeUnavailableError);
    expect(await failing.list({ ownerId: ownerId("noecs") })).toHaveLength(0);

    // start(): a launch failure returns a typed `unavailable` Result (→ 503) and
    // rolls the claim back to stopped, so the workspace stays wake-able.
    const ws = await service.create({
      ownerId: ownerId("noecs2"),
      baseImage: baseImage("golden/node:20"),
    });
    unwrap(await service.stop(workspaceId(ws.id)));
    const failed = await failing.start(workspaceId(ws.id));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.kind).toBe("unavailable");
    expect((await service.get(workspaceId(ws.id)))?.state).toBe("stopped");
  });

  it("connect wakes a scaled-to-zero workspace and is a no-op when already running", async () => {
    const ws = await service.create({
      ownerId: ownerId("erin"),
      baseImage: baseImage("golden/node:20"),
    });

    // Already running → connect returns it as-is (no restart, unlike start()).
    const ready = unwrap(await service.connect(workspaceId(ws.id)));
    expect(ready.state).toBe("running");

    unwrap(await service.stop(workspaceId(ws.id)));

    // Scaled to zero → connect wakes it from the snapshot.
    const woken = unwrap(await service.connect(workspaceId(ws.id)));
    expect(woken.state).toBe("running");
    expect(woken.id).toBe(ws.id);
  });

  it("heartbeat refreshes activity and rejects a stopped workspace", async () => {
    const ws = await service.create({
      ownerId: ownerId("frank"),
      baseImage: baseImage("golden/node:20"),
    });
    const beat = unwrap(await service.heartbeat(workspaceId(ws.id)));
    expect(beat.state).toBe("running");

    unwrap(await service.stop(workspaceId(ws.id)));
    const afterStop = await service.heartbeat(workspaceId(ws.id));
    expect(afterStop.ok).toBe(false);
    if (!afterStop.ok) expect(afterStop.error.kind).toBe("conflict");
  });

  it("an active:false heartbeat records liveness without refreshing the idle window", async () => {
    const ws = await service.create({
      ownerId: ownerId("frank2"),
      baseImage: baseImage("golden/node:20"),
    });
    unwrap(await service.heartbeat(workspaceId(ws.id)));
    const before = await service.inspect(workspaceId(ws.id));

    // Alive-but-unused: functional lands, lastActivity does NOT move — that's
    // what lets the reconciler's idle window age on an untouched workspace.
    const idleBeat = unwrap(
      await service.heartbeat(workspaceId(ws.id), {
        active: false,
        functional: { ide: true, workspace: true },
      }),
    );
    expect(idleBeat.functional).toBe("ok");
    const after = await service.inspect(workspaceId(ws.id));
    expect(after?.workspace.lastActivity).toBe(before?.workspace.lastActivity);
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

  it("rejects an invalid transition (start while running) with a conflict", async () => {
    const ws = await service.create({ ownerId: ownerId("carol"), baseImage: baseImage("img") });
    const result = await service.start(workspaceId(ws.id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("removes a workspace: tombstones it, then finishDeleting removes the record", async () => {
    const ws = await service.create({ ownerId: ownerId("dave"), baseImage: baseImage("img") });
    // remove() is async now: it marks the `deleting` tombstone (record persists).
    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    const tombstoned = await service.get(workspaceId(ws.id));
    expect(tombstoned?.state).toBe("deleting");
    expect((await service.listDeleting()).map((w) => w.id)).toContain(ws.id);
    // The reconciler's finishDeleting converges teardown and removes the record.
    expect((await service.finishDeleting(workspaceId(ws.id))).ok).toBe(true);
    expect(await service.get(workspaceId(ws.id))).toBeNull();
  });

  it("finishDeleting retains a final data-safety snapshot (Middle policy)", async () => {
    // A working session (live volume, no prior snapshot) is deleted: finishDeleting
    // must capture a RETAINED final snapshot so the data survives the teardown and the
    // orphan-GC keep-set never reaps it.
    const ws = await service.create({ ownerId: ownerId("retain"), baseImage: baseImage("img") });
    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.finishDeleting(workspaceId(ws.id))).ok).toBe(true);

    const snaps = await storage.listSnapshots();
    expect(snaps.some((s) => s.retained === true)).toBe(true);
  });

  it("finishDeleting takes a FRESH snapshot when a running workspace's snapshot is stale (no data loss)", async () => {
    // A running workspace snapshotted long ago, then deleted, has a LIVE volume holding
    // newer work than the stale snapshot. finishDeleting must capture that live volume —
    // NOT just re-tag the stale snapshot (which would lose everything since it).
    const ws = await service.create({ ownerId: ownerId("stale"), baseImage: baseImage("img") });
    expect((await service.snapshot(workspaceId(ws.id))).ok).toBe(true); // snapshot at T0, volume kept
    expect((await storage.listSnapshots()).length).toBe(1);

    // A service whose clock is 7h later → the T0 snapshot is now older than the 6h interval.
    const later = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, TEST_TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
      clock: fixedClock("2026-06-01T07:00:00.000Z"),
    });
    expect((await later.remove(workspaceId(ws.id))).ok).toBe(true);
    expect((await later.finishDeleting(workspaceId(ws.id))).ok).toBe(true);

    const snaps = await storage.listSnapshots();
    expect(snaps.length).toBe(2); // a FRESH snapshot of the live volume was taken
    expect(snaps.some((s) => s.retained === true)).toBe(true);
  });

  it("finishDeleting retains the EXISTING snapshot of a stopped workspace (no live volume to re-snapshot)", async () => {
    // Scale-to-zero releases the volume and leaves a snapshot (the data). Deleting a stopped
    // workspace must tag THAT snapshot retained — not take a new one (there's no live volume).
    const ws = await service.create({ ownerId: ownerId("stopped"), baseImage: baseImage("img") });
    expect((await service.stop(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.get(workspaceId(ws.id)))?.state).toBe("stopped");
    const before = (await storage.listSnapshots()).length;
    expect(before).toBe(1);

    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.finishDeleting(workspaceId(ws.id))).ok).toBe(true);

    const after = await storage.listSnapshots();
    expect(after.length).toBe(before); // no NEW snapshot — the existing one is reused
    expect(after.every((s) => s.retained === true)).toBe(true);
  });

  it("finishDeleting is idempotent on re-run after the tombstone is gone (converged)", async () => {
    const ws = await service.create({ ownerId: ownerId("idem"), baseImage: baseImage("img") });
    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.finishDeleting(workspaceId(ws.id))).ok).toBe(true);
    const after = (await storage.listSnapshots()).filter((s) => s.retained === true).length;
    // A re-run finds the record already gone → no-op, no second retained snapshot.
    expect((await service.finishDeleting(workspaceId(ws.id))).ok).toBe(true);
    expect((await storage.listSnapshots()).filter((s) => s.retained === true).length).toBe(after);
  });

  it("rejects snapshot of a deleting tombstone (it still has a volume) with a conflict", async () => {
    const ws = await service.create({ ownerId: ownerId("heidi"), baseImage: baseImage("img") });
    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    expect((await service.get(workspaceId(ws.id)))?.state).toBe("deleting");
    // A `deleting` workspace keeps its volumeId until teardown; without the state guard
    // a racing snapshot would write a fresh latestSnapshotId onto the tombstone the
    // reconciler is removing. It must be refused as a conflict, not silently succeed.
    const snap = await service.snapshot(workspaceId(ws.id));
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error.kind).toBe("conflict");
  });

  it("remove() of an absent workspace returns a not_found domain error", async () => {
    // The DELETE route relies on this to map the concurrent double-delete race to
    // 404 (via the central mapper) instead of a 500.
    const result = await service.remove(workspaceId("ws-never-existed"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });
});

describe("CatalogService", () => {
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
      tags: ["typescript", "node"],
      tools: ["pnpm", "eslint"],
    });
    expect(created).toMatchObject({
      name: "Node 20",
      enabled: true,
      tags: ["typescript", "node"],
      tools: ["pnpm", "eslint"],
    });

    expect((await catalog.list()).map((e) => e.id)).toContain(created.id);
    expect(await catalog.get(baseImageId(created.id))).toMatchObject({
      image: "golden/node:20",
      tags: ["typescript", "node"],
    });

    const updated = await catalog.update(baseImageId(created.id), {
      enabled: false,
      tools: ["node", "pnpm"],
    });
    expect(updated.ok).toBe(true);
    if (updated.ok)
      expect(updated.value).toMatchObject({ enabled: false, tools: ["node", "pnpm"] });

    expect((await catalog.remove(baseImageId(created.id))).ok).toBe(true);
    expect(await catalog.get(baseImageId(created.id))).toBeNull();
  });

  it("update/remove of a missing entry return a not_found domain error", async () => {
    const missing = baseImageId("img-absent");
    const upd = await catalog.update(missing, { enabled: false });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.kind).toBe("not_found");

    const rem = await catalog.remove(missing);
    expect(rem.ok).toBe(false);
    if (!rem.ok) expect(rem.error.kind).toBe("not_found");
  });

  it("assertEnabled is ok only for an enabled catalog image", async () => {
    const entry = await catalog.create({ name: "Go", image: baseImage("golden/go:1.22") });
    expect((await catalog.assertEnabled(baseImage("golden/go:1.22"))).ok).toBe(true);

    // Unknown image, and a disabled one, both fail with a conflict.
    expect((await catalog.assertEnabled(baseImage("golden/rust:1"))).ok).toBe(false);
    await catalog.update(baseImageId(entry.id), { enabled: false });
    expect((await catalog.assertEnabled(baseImage("golden/go:1.22"))).ok).toBe(false);
  });

  it("update CAS: stale version is rejected, current version wins", async () => {
    const created = await catalog.create({
      name: "Concurrent",
      image: baseImage("golden/concurrent:1"),
    });
    const id = baseImageId(created.id);

    // First update succeeds (version 0 → 1).
    const r1 = await catalog.update(id, { name: "first" });
    expect(r1.ok).toBe(true);

    // Simulate a stale writer: write directly through the ElectroDB entity with
    // the OLD version (version=0), bypassing the service's read step. This is
    // exactly what a concurrent service.update() call does when its read
    // interleaves before r1's write.
    const entity = makeBaseImageEntity(client, TEST_TABLE);
    let staleWriteThrew = false;
    try {
      await entity
        .patch({ id: created.id })
        .set({ name: "stale-writer", version: 0 })
        .where(({ version }, { eq }) => eq(version, 0))
        .go();
    } catch {
      staleWriteThrew = true;
    }
    expect(staleWriteThrew).toBe(true);

    // The first writer's value is visible; the stale writer did not apply.
    const final = await catalog.get(id);
    expect(final?.name).toBe("first");
  });

  it("remove CAS: stale version is rejected", async () => {
    const created = await catalog.create({
      name: "Remove Race",
      image: baseImage("golden/remove:1"),
    });
    const id = baseImageId(created.id);

    // Service-level update succeeds (version 0 → 1).
    const upd = await catalog.update(id, { name: "updated" });
    expect(upd.ok).toBe(true);

    // Stale delete with the old version should fail the CAS condition.
    const entity = makeBaseImageEntity(client, TEST_TABLE);
    let staleDeleteThrew = false;
    try {
      await entity
        .delete({ id: created.id })
        .where(({ version }, { eq }) => eq(version, 0))
        .go();
    } catch {
      staleDeleteThrew = true;
    }
    expect(staleDeleteThrew).toBe(true);

    // The entry still exists (the stale delete was rejected).
    expect(await catalog.get(id)).not.toBeNull();
  });
});

describe("HealthService", () => {
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

describe("DerivedAuditSource + DerivedLogSource", () => {
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

describe("WorkspaceService quota enforcement ", () => {
  const QUOTA_TABLE = "ecs-dev-desktop-cp-quota-integ";
  const LIMIT = 3;
  let client: ReturnType<typeof createDynamoClient>;

  // A service wired with BOTH the audit ledger and the per-owner counter — the
  // combination that activates the atomic quota path in `create`.
  function quotaService(): WorkspaceService {
    // Each call shares the table; storage is per-service (in-memory fake).
    return new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, QUOTA_TABLE),
      storage: fakeStorageHolder,
      compute: fakeComputeHolder,
      clock: fixedClock(),
      audit: makeAuditEventEntity(client, QUOTA_TABLE),
      ownerCounts: makeOwnerWorkspaceCountEntity(client, QUOTA_TABLE),
    });
  }
  let fakeStorageHolder: FakeStorageProvider;
  let fakeComputeHolder: FakeComputeProvider;
  let service: WorkspaceService;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, QUOTA_TABLE);
    await ensureTable(client, QUOTA_TABLE);
  });
  afterAll(async () => {
    await dropTable(client, QUOTA_TABLE);
  });
  beforeEach(async () => {
    fakeStorageHolder = await FakeStorageProvider.create();
    fakeComputeHolder = new FakeComputeProvider(fakeStorageHolder);
    service = quotaService();
  });

  const create = (owner: string): Promise<unknown> =>
    service.create({ ownerId: ownerId(owner), baseImage: baseImage("img"), quotaLimit: LIMIT });

  it("allows exactly `limit` sequential creates, then rejects with QuotaExceededError", async () => {
    for (let i = 0; i < LIMIT; i++) await create("seq-user");
    await expect(create("seq-user")).rejects.toBeInstanceOf(QuotaExceededError);
    // A DIFFERENT owner is unaffected (the counter is per-owner).
    await expect(create("other-user")).resolves.toBeDefined();
  });

  it("closes the TOCTOU race: concurrent creates can NEVER exceed the cap", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: LIMIT + 4 }, () => create("race-user")),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    // The security property: the cap is NEVER exceeded by a concurrent burst.
    expect(ok).toBeLessThanOrEqual(LIMIT);
    expect(ok).toBeGreaterThan(0);
    // Every rejection is the quota error (not an unexpected failure).
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(QuotaExceededError);
    }
    // The persisted reality matches: at most `limit` workspaces exist for the owner.
    expect((await service.list({ ownerId: ownerId("race-user") })).length).toBeLessThanOrEqual(
      LIMIT,
    );
  });

  it("finishDeleting decrements the counter, freeing a slot", async () => {
    const made: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const ws = (await service.create({
        ownerId: ownerId("del-user"),
        baseImage: baseImage("img"),
        quotaLimit: LIMIT,
      })) as { id: string };
      made.push(ws.id);
    }
    // At the cap → the next create is refused.
    await expect(create("del-user")).rejects.toBeInstanceOf(QuotaExceededError);
    // Fully remove one workspace (tombstone → finishDeleting hard-delete + decrement).
    expect((await service.remove(workspaceId(made[0] ?? ""))).ok).toBe(true);
    expect((await service.finishDeleting(workspaceId(made[0] ?? ""))).ok).toBe(true);
    // The freed slot lets a new create succeed.
    await expect(create("del-user")).resolves.toBeDefined();
  });

  it("reconcileOwnerCounts self-heals counters drifted from the actual records", async () => {
    const counts = makeOwnerWorkspaceCountEntity(client, QUOTA_TABLE);
    // Owner A: 2 real workspaces, but the counter drifted HIGH (e.g. an out-of-band
    // record removal that never decremented) — which would wrongly block new creates.
    await create("drift-a");
    await create("drift-a");
    await counts.update({ ownerId: "drift-a" }).add({ count: 5 }).go(); // 7, actual 2
    // Owner B: 1 real workspace, counter drifted LOW (a lost-race decrement) — which
    // would wrongly let creates slip past the cap.
    await create("drift-b");
    await counts.update({ ownerId: "drift-b" }).subtract({ count: 1 }).go(); // 0, actual 1

    const corrected = await service.reconcileOwnerCounts();
    expect(corrected).toBeGreaterThanOrEqual(2);
    expect((await counts.get({ ownerId: "drift-a" }).go()).data?.count).toBe(2);
    expect((await counts.get({ ownerId: "drift-b" }).go()).data?.count).toBe(1);

    // Convergent: a second pass finds nothing to correct (all counters now match).
    expect(await service.reconcileOwnerCounts()).toBe(0);
  });
});

describe("WorkspaceService.recordSecurityEvent idempotency", () => {
  const SEC_TABLE = "ecs-dev-desktop-cp-sec-integ";
  let client: ReturnType<typeof createDynamoClient>;

  beforeAll(async () => {
    client = createDynamoClient();
    await dropTable(client, SEC_TABLE);
    await ensureTable(client, SEC_TABLE);
  });
  afterAll(async () => {
    await dropTable(client, SEC_TABLE);
  });

  it("dedupes a retried privilege attempt — one metric, not two", async () => {
    const storage = await FakeStorageProvider.create();
    const metrics = new InMemoryMetricSink();
    const service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, SEC_TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
      clock: fixedClock(), // constant time → both calls land in the same idempotency bucket
      audit: makeAuditEventEntity(client, SEC_TABLE),
      metrics,
    });
    const ws = await service.create({ ownerId: ownerId("sec-user"), baseImage: baseImage("img") });
    const evt = { kind: "privilege_attempt", tool: "docker" } as const;
    // The in-workspace guard's curl --retry can deliver the SAME attempt twice.
    expect((await service.recordSecurityEvent(workspaceId(ws.id), evt)).ok).toBe(true);
    expect((await service.recordSecurityEvent(workspaceId(ws.id), evt)).ok).toBe(true);
    const counted = metrics.recorded.filter((m) => m.name === METRIC_SECURITY_PRIVILEGE_ATTEMPT);
    expect(counted).toHaveLength(1); // the retry deduped — counted exactly once
  });

  it("fails loud (no double-counted metric) when no audit ledger is wired", async () => {
    // Without an audit ledger the dedup store is absent, so a retried attempt could not be
    // deduped — the method must fail loud rather than emit an unauditable, double-counted
    // metric. (Production always wires the ledger; this guards a misconfiguration.)
    const storage = await FakeStorageProvider.create();
    const metrics = new InMemoryMetricSink();
    const service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, SEC_TABLE),
      storage,
      compute: new FakeComputeProvider(storage),
      clock: fixedClock(),
      metrics,
      // audit intentionally omitted
    });
    const ws = await service.create({
      ownerId: ownerId("sec-user-2"),
      baseImage: baseImage("img"),
    });
    const evt = { kind: "privilege_attempt", tool: "docker" } as const;
    const result = await service.recordSecurityEvent(workspaceId(ws.id), evt);
    expect(result.ok).toBe(false);
    expect(metrics.recorded.filter((m) => m.name === METRIC_SECURITY_PRIVILEGE_ATTEMPT)).toEqual(
      [],
    );
  });
});
