// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  conflictError,
  err,
  FakeStorageProvider,
  fixedClock,
  isoTimestamp,
  ok,
  taskId,
  workspaceId,
  type ComputeProvider,
  type StorageProvider,
  type TaskId,
  type WorkspaceTaskRef,
} from "@edd/core";
import { describe, expect, it } from "vitest";

import { Reconciler, selectIdle, type ActiveWorkspace, type ReconcilerService } from "./index";

const THIRTY_MIN = 30 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** A ReconcilerService whose methods all no-op; override per test. */
function fakeService(overrides: Partial<ReconcilerService> = {}): ReconcilerService {
  return {
    listActive: () => Promise.resolve([]),
    // Default: every listed task is healthy (drift sweep finds nothing).
    reconcileTaskLoss: () => Promise.resolve(ok({ lost: false, workspace: undefined })),
    stop: () => Promise.reject(new Error("stop not expected")),
    listSnapshotCandidates: () => Promise.resolve([]),
    snapshot: () => Promise.reject(new Error("snapshot not expected")),
    listReferencedStorage: () => Promise.resolve({ volumeIds: [], snapshotIds: [] }),
    listReferencedTasks: () => Promise.resolve([]),
    ...overrides,
  };
}

async function emptyStorage(): Promise<StorageProvider> {
  return FakeStorageProvider.create();
}

describe("selectIdle", () => {
  it("selects only workspaces idle past the threshold", () => {
    const now = isoTimestamp("2026-06-01T01:00:00.000Z");
    const active: ActiveWorkspace[] = [
      { id: workspaceId("ws-old"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
      { id: workspaceId("ws-fresh"), lastActivity: isoTimestamp("2026-06-01T00:59:00.000Z") },
    ];
    expect(selectIdle(active, now, THIRTY_MIN)).toEqual([workspaceId("ws-old")]);
  });
});

describe("Reconciler.detectDrift", () => {
  it("counts lost and skipped reconciles and runs before the idle sweep", async () => {
    const calls: string[] = [];
    const active = [
      { id: workspaceId("ws-lost"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
      { id: workspaceId("ws-ok"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
      { id: workspaceId("ws-raced"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
    ];
    const service = fakeService({
      listActive: () => Promise.resolve(active),
      reconcileTaskLoss: (id) => {
        calls.push(`drift:${id}`);
        if (id === workspaceId("ws-lost"))
          return Promise.resolve(ok({ lost: true, workspace: undefined }));
        if (id === workspaceId("ws-raced"))
          return Promise.resolve(err(conflictError("concurrent update")));
        return Promise.resolve(ok({ lost: false, workspace: undefined }));
      },
      stop: (id) => {
        calls.push(`stop:${id}`);
        return Promise.resolve(ok(undefined));
      },
      snapshot: () => Promise.resolve(ok(undefined)),
    });

    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock(isoTimestamp("2026-06-01T02:00:00.000Z")),
    });
    const result = await reconciler.runMaintenance();

    expect(result.drift).toEqual({ scanned: 3, lost: 1, skipped: 1 });
    // Every drift reconcile happened before any idle stop.
    const firstStop = calls.findIndex((c) => c.startsWith("stop:"));
    const lastDrift = calls
      .map((c, i) => (c.startsWith("drift:") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(lastDrift).toBeLessThan(firstStop === -1 ? Number.MAX_SAFE_INTEGER : firstStop);
  });
});

describe("Reconciler.runOnce", () => {
  it("stops idle workspaces and reports a summary", async () => {
    const stopped: string[] = [];
    const service = fakeService({
      listActive: () =>
        Promise.resolve([
          { id: workspaceId("ws-1"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
        ]),
      stop: (id) => {
        stopped.push(id);
        return Promise.resolve(ok(undefined));
      },
    });

    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      idleThresholdMs: 1000,
    });

    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 1, skipped: 0 });
    expect(stopped).toEqual(["ws-1"]);
  });

  it("leaves freshly-active workspaces running", async () => {
    const service = fakeService({
      listActive: () =>
        Promise.resolve([
          { id: workspaceId("ws-1"), lastActivity: isoTimestamp("2026-06-01T01:59:00.000Z") },
        ]),
    });
    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      idleThresholdMs: THIRTY_MIN,
    });
    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 0, skipped: 0 });
  });

  it("skips (does not throw) a workspace whose stop loses a state race", async () => {
    const service = fakeService({
      listActive: () =>
        Promise.resolve([
          { id: workspaceId("ws-1"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
        ]),
      // The workspace changed state since it was listed → stop rejects with a conflict.
      stop: () => Promise.resolve(err(conflictError("already stopped"))),
    });
    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      idleThresholdMs: 1000,
    });
    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 0, skipped: 1 });
  });
});

describe("Reconciler.snapshotDue", () => {
  it("snapshots workspaces never snapshotted or past the interval", async () => {
    const snapped: string[] = [];
    const service = fakeService({
      listSnapshotCandidates: () =>
        Promise.resolve([
          { id: workspaceId("ws-never") },
          {
            id: workspaceId("ws-fresh"),
            latestSnapshotAt: isoTimestamp("2026-06-01T01:59:00.000Z"),
          },
        ]),
      snapshot: (id) => {
        snapped.push(id);
        return Promise.resolve(ok(undefined));
      },
    });

    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      snapshotIntervalMs: THIRTY_MIN,
    });

    expect(await reconciler.snapshotDue()).toEqual({ scanned: 2, snapshotted: 1, skipped: 0 });
    expect(snapped).toEqual(["ws-never"]);
  });
});

describe("Reconciler.collectGarbage", () => {
  it("reaps unreferenced volumes/snapshots past the grace window, keeping the rest", async () => {
    const storage = await FakeStorageProvider.create(fixedClock("2026-06-01T00:00:00.000Z"));
    const keep = await storage.createVolume();
    const orphan = await storage.createVolume();
    const keepSnap = await storage.createSnapshot(keep.id);
    const orphanSnap = await storage.createSnapshot(keep.id);

    const service = fakeService({
      listReferencedStorage: () =>
        Promise.resolve({ volumeIds: [keep.id], snapshotIds: [keepSnap.id] }),
    });

    const reconciler = new Reconciler({
      service,
      storage,
      clock: fixedClock("2026-06-01T02:00:00.000Z"), // 2h later — past the grace window
      gcGraceMs: ONE_HOUR,
    });

    expect(await reconciler.collectGarbage()).toEqual({
      volumesDeleted: 1,
      snapshotsDeleted: 1,
      volumesFailed: 0,
      snapshotsFailed: 0,
    });
    expect((await storage.listVolumes()).map((v) => v.id)).toEqual([keep.id]);
    expect((await storage.listSnapshots()).map((s) => s.id)).toEqual([keepSnap.id]);
    // The orphans really are gone.
    expect((await storage.listVolumes()).map((v) => v.id)).not.toContain(orphan.id);
    expect((await storage.listSnapshots()).map((s) => s.id)).not.toContain(orphanSnap.id);
  });

  it("spares an unreferenced resource still inside the grace window", async () => {
    const storage = await FakeStorageProvider.create(fixedClock("2026-06-01T00:00:00.000Z"));
    const orphan = await storage.createVolume();

    const reconciler = new Reconciler({
      service: fakeService(),
      storage,
      clock: fixedClock("2026-06-01T00:30:00.000Z"), // only 30m later
      gcGraceMs: ONE_HOUR,
    });

    expect(await reconciler.collectGarbage()).toEqual({
      volumesDeleted: 0,
      snapshotsDeleted: 0,
      volumesFailed: 0,
      snapshotsFailed: 0,
    });
    expect((await storage.listVolumes()).map((v) => v.id)).toEqual([orphan.id]);
  });

  it("continues GC when one delete fails — reaps the rest, counts + logs the failure", async () => {
    const inner = await FakeStorageProvider.create(fixedClock("2026-06-01T00:00:00.000Z"));
    const stuck = await inner.createVolume();
    const reapable = await inner.createVolume();

    // A storage where deleting `stuck` throws (as real EBS does for a volume still
    // in-use / detaching), delegating everything else to the fake.
    const storage: StorageProvider = {
      createVolume: (opts) => inner.createVolume(opts),
      readFile: (v, p) => inner.readFile(v, p),
      writeFile: (v, p, d) => inner.writeFile(v, p, d),
      createSnapshot: (v) => inner.createSnapshot(v),
      deleteVolume: (id) =>
        id === stuck.id
          ? Promise.reject(new Error("VolumeInUse: volume is still attached"))
          : inner.deleteVolume(id),
      deleteSnapshot: (id) => inner.deleteSnapshot(id),
      listVolumes: () => inner.listVolumes(),
      listSnapshots: () => inner.listSnapshots(),
    };

    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const reconciler = new Reconciler({
      service: fakeService(), // nothing referenced — both volumes are orphans
      storage,
      clock: fixedClock("2026-06-01T02:00:00.000Z"), // past the grace window
      gcGraceMs: ONE_HOUR,
      logger: { warn: (message, fields) => warnings.push({ message, fields }) },
    });

    // The stuck delete fails but the reapable orphan is still collected — the sweep
    // is not aborted — and the failure is counted + logged (not swallowed).
    expect(await reconciler.collectGarbage()).toEqual({
      volumesDeleted: 1,
      snapshotsDeleted: 0,
      volumesFailed: 1,
      snapshotsFailed: 0,
    });
    expect((await storage.listVolumes()).map((v) => v.id)).toEqual([stuck.id]);
    expect((await storage.listVolumes()).map((v) => v.id)).not.toContain(reapable.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ volumeId: stuck.id });
  });
});

describe("Reconciler.reapOrphanTasks", () => {
  const startedLongAgo = isoTimestamp("2026-06-01T00:00:00.000Z"); // well before the clock

  const ref = (id: string, ws: string): WorkspaceTaskRef => ({
    id: taskId(id),
    workspaceId: workspaceId(ws),
    startedAt: startedLongAgo,
  });

  /** A ComputeProvider that lists `tasks` and records every stopTask; `failStop`
   * makes that one stop throw (a throttled/failed StopTask). */
  function fakeCompute(opts: {
    tasks: readonly WorkspaceTaskRef[];
    stops: TaskId[];
    failStop?: TaskId;
  }): ComputeProvider {
    return {
      runTask: () => Promise.reject(new Error("runTask not expected")),
      taskState: () => Promise.resolve("stopped"),
      listWorkspaceTasks: () => Promise.resolve(opts.tasks),
      stopTask: (id) => {
        if (opts.failStop !== undefined && id === opts.failStop) {
          return Promise.reject(new Error("StopTask throttled"));
        }
        opts.stops.push(id);
        return Promise.resolve();
      },
    };
  }

  it("stops a tagged task no record references and spares a referenced one", async () => {
    const stops: TaskId[] = [];
    const orphan = ref("task-orphan", "ws-1");
    const kept = ref("task-kept", "ws-2");
    const reconciler = new Reconciler({
      service: fakeService({ listReferencedTasks: () => Promise.resolve([kept.id]) }),
      storage: await emptyStorage(),
      compute: fakeCompute({ tasks: [orphan, kept], stops }),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      gcGraceMs: ONE_HOUR,
    });

    expect(await reconciler.reapOrphanTasks()).toEqual({ scanned: 2, reaped: 1, failed: 0 });
    expect(stops).toEqual([orphan.id]);
  });

  it("counts (does not throw) a stop that fails, still reaping the rest", async () => {
    const stops: TaskId[] = [];
    const warnings: Record<string, unknown>[] = [];
    const a = ref("task-a", "ws-a");
    const b = ref("task-b", "ws-b");
    const reconciler = new Reconciler({
      service: fakeService({ listReferencedTasks: () => Promise.resolve([]) }),
      storage: await emptyStorage(),
      compute: fakeCompute({ tasks: [a, b], stops, failStop: a.id }),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      gcGraceMs: ONE_HOUR,
      logger: { warn: (_m, fields) => warnings.push(fields ?? {}) },
    });

    expect(await reconciler.reapOrphanTasks()).toEqual({ scanned: 2, reaped: 1, failed: 1 });
    expect(stops).toEqual([b.id]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ taskId: a.id, workspaceId: a.workspaceId });
  });

  it("is a no-op when no compute provider is wired (e.g. the local fake path)", async () => {
    const reconciler = new Reconciler({
      service: fakeService(),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    expect(await reconciler.reapOrphanTasks()).toEqual({ scanned: 0, reaped: 0, failed: 0 });
  });
});
