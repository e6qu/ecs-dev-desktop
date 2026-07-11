// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  conflictError,
  err,
  FakeStorageProvider,
  fixedClock,
  isoTimestamp,
  ok,
  snapshotId,
  taskId,
  volumeId,
  workspaceId,
  type ComputeProvider,
  type StorageProvider,
  type TaskId,
  type WorkspaceTaskRef,
} from "@edd/core";
import { describe, expect, it } from "vitest";

import {
  Reconciler,
  selectIdle,
  type ActiveWorkspace,
  type ControlPlaneScaleConfig,
  type ReconcilerService,
} from "./index";

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
    listRuntimeSecretWorkspaceIds: () => Promise.resolve([]),
    listStuckProvisioning: () => Promise.resolve([]),
    recoverStuckProvisioning: () => Promise.reject(new Error("recover not expected")),
    listDeleting: () => Promise.resolve([]),
    finishDeleting: () => Promise.reject(new Error("finishDeleting not expected")),
    listRecoverableErrors: () => Promise.resolve([]),
    recoverError: () => Promise.reject(new Error("recoverError not expected")),
    listSnapshotReferences: () => Promise.resolve([]),
    markSnapshotLostFor: () => Promise.reject(new Error("markSnapshotLostFor not expected")),
    reconcileOwnerCounts: () => Promise.resolve(0),
    purgeExpiredTombstones: () => Promise.resolve(0),
    listStopping: () => Promise.resolve([]),
    finishStop: () => Promise.resolve(ok(undefined)),
    ...overrides,
  };
}

async function emptyStorage(): Promise<StorageProvider> {
  return FakeStorageProvider.create();
}

/** A compute backend that can't run/stop tasks — for the no-op / never-throws sweep paths.
 * Extend with `pruneTaskDefinitions` etc. via spread when a test needs that surface. */
function inertCompute(): ComputeProvider {
  return {
    runTask: () => Promise.reject(new Error("x")),
    taskState: () => Promise.resolve("stopped"),
    stopTask: () => Promise.resolve(),
  };
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

    expect(result.drift).toEqual({ scanned: 3, lost: 1, skipped: 1, failed: 0 });
    // Every drift reconcile happened before any idle stop.
    const firstStop = calls.findIndex((c) => c.startsWith("stop:"));
    const lastDrift = calls
      .map((c, i) => (c.startsWith("drift:") ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(lastDrift).toBeLessThan(firstStop === -1 ? Number.MAX_SAFE_INTEGER : firstStop);
  });

  it("isolates a workspace whose reconcile THROWS — the sweep scans the rest", async () => {
    // The service converts only version conflicts to a Result; a transient infra error
    // (throttle/5xx) THROWS. One unlucky record must not abort the whole sweep (which
    // would skip every later sweep step for the tick).
    const seen: string[] = [];
    const active = [
      { id: workspaceId("ws-throws"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
      { id: workspaceId("ws-ok"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
    ];
    const service = fakeService({
      listActive: () => Promise.resolve(active),
      reconcileTaskLoss: (id) => {
        seen.push(id);
        if (id === workspaceId("ws-throws")) throw new Error("ThrottlingException");
        return Promise.resolve(ok({ lost: false, workspace: undefined }));
      },
    });
    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock(isoTimestamp("2026-06-01T02:00:00.000Z")),
    });

    expect(await reconciler.detectDrift()).toEqual({
      scanned: 2,
      lost: 0,
      skipped: 0,
      failed: 1,
    });
    // Both workspaces were visited — the throw on the first did not abort the loop.
    expect(seen).toEqual([workspaceId("ws-throws"), workspaceId("ws-ok")]);
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

    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 1, skipped: 0, failed: 0 });
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
    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 0, skipped: 0, failed: 0 });
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
    expect(await reconciler.runOnce()).toEqual({ scanned: 1, stopped: 0, skipped: 1, failed: 0 });
  });

  it("passes the idle threshold to stop so a workspace resumed mid-sweep is re-checked", async () => {
    let seenOpts: { requireIdleForMs?: number } | undefined;
    const service = fakeService({
      listActive: () =>
        Promise.resolve([
          { id: workspaceId("ws-1"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
        ]),
      stop: (_id, _actor, opts) => {
        seenOpts = opts;
        return Promise.resolve(ok(undefined));
      },
    });
    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      idleThresholdMs: THIRTY_MIN,
    });
    await reconciler.runOnce();
    expect(seenOpts).toEqual({ requireIdleForMs: THIRTY_MIN });
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

    expect(await reconciler.snapshotDue()).toEqual({
      scanned: 2,
      snapshotted: 1,
      skipped: 0,
      failed: 0,
    });
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

  it("never reaps a RETAINED snapshot, even unreferenced and past grace (Middle policy)", async () => {
    // The data-safety snapshot finishDeleting keeps: its workspace record is gone (so it
    // is unreferenced) and it is old, but the retain tag must keep it through GC.
    const storage = await FakeStorageProvider.create(fixedClock("2026-06-01T00:00:00.000Z"));
    const vol = await storage.createVolume();
    const retained = await storage.createSnapshot(vol.id, { retain: true });
    const orphan = await storage.createSnapshot(vol.id);

    const reconciler = new Reconciler({
      // Nothing referenced — both snapshots are unreferenced and past grace.
      service: fakeService({
        listReferencedStorage: () => Promise.resolve({ volumeIds: [], snapshotIds: [] }),
      }),
      storage,
      clock: fixedClock("2026-06-01T02:00:00.000Z"), // 2h later — past the grace window
      gcGraceMs: ONE_HOUR,
    });

    const result = await reconciler.collectGarbage();
    expect(result.snapshotsDeleted).toBe(1); // only the plain orphan
    const remaining = (await storage.listSnapshots()).map((s) => s.id);
    expect(remaining).toContain(retained.id); // the retained snapshot survives
    expect(remaining).not.toContain(orphan.id);
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
      createSnapshot: (v, opts) => inner.createSnapshot(v, opts),
      tagSnapshotRetained: (id) => inner.tagSnapshotRetained(id),
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

describe("Reconciler.reapOrphanSecrets", () => {
  const createdLongAgo = isoTimestamp("2026-06-01T00:00:00.000Z"); // before the clock

  const secretRef = (ws: string) => ({
    name: `edd/workspace/${ws}/agent`,
    workspaceId: workspaceId(ws),
    createdAt: createdLongAgo,
  });

  function fakeCompute(opts: {
    secrets: ReturnType<typeof secretRef>[];
    deletes: string[];
    failDelete?: string;
  }): ComputeProvider {
    return {
      runTask: () => Promise.reject(new Error("runTask not expected")),
      taskState: () => Promise.resolve("stopped"),
      stopTask: () => Promise.resolve(),
      listWorkspaceAgentSecrets: () => Promise.resolve(opts.secrets),
      deleteAgentSecret: (name) => {
        if (opts.failDelete !== undefined && name === opts.failDelete) {
          return Promise.reject(new Error("DeleteSecret throttled"));
        }
        opts.deletes.push(name);
        return Promise.resolve();
      },
    };
  }

  it("deletes secrets for non-runtime workspaces and spares one still referenced by a task", async () => {
    const deletes: string[] = [];
    const orphan = secretRef("ws-dead");
    const stopped = secretRef("ws-stopped");
    const live = secretRef("ws-running");
    const reconciler = new Reconciler({
      service: fakeService({
        listRuntimeSecretWorkspaceIds: () => Promise.resolve([workspaceId("ws-running")]),
      }),
      storage: await emptyStorage(),
      compute: fakeCompute({ secrets: [orphan, stopped, live], deletes }),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      gcGraceMs: ONE_HOUR,
    });
    expect(await reconciler.reapOrphanSecrets()).toEqual({ scanned: 3, reaped: 2, failed: 0 });
    expect(deletes).toEqual([orphan.name, stopped.name]);
  });

  it("counts (does not throw) a delete that fails, still reaping the rest", async () => {
    const deletes: string[] = [];
    const warnings: Record<string, unknown>[] = [];
    const a = secretRef("ws-a");
    const b = secretRef("ws-b");
    const reconciler = new Reconciler({
      service: fakeService({ listRuntimeSecretWorkspaceIds: () => Promise.resolve([]) }),
      storage: await emptyStorage(),
      compute: fakeCompute({ secrets: [a, b], deletes, failDelete: a.name }),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      gcGraceMs: ONE_HOUR,
      logger: { warn: (_m, fields) => warnings.push(fields ?? {}) },
    });
    expect(await reconciler.reapOrphanSecrets()).toEqual({ scanned: 2, reaped: 1, failed: 1 });
    expect(deletes).toEqual([b.name]);
    expect(warnings).toHaveLength(1);
  });

  it("is a no-op when the compute backend can't list/delete secrets (fakes)", async () => {
    const reconciler = new Reconciler({
      service: fakeService(),
      storage: await emptyStorage(),
      compute: inertCompute(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    expect(await reconciler.reapOrphanSecrets()).toEqual({ scanned: 0, reaped: 0, failed: 0 });
  });
});

describe("Reconciler.pruneTaskDefinitions", () => {
  it("delegates to the backend with the keep-count and reports the count", async () => {
    let keepSeen: number | undefined;
    const reconciler = new Reconciler({
      service: fakeService(),
      storage: await emptyStorage(),
      compute: {
        ...inertCompute(),
        pruneTaskDefinitions: (keep) => {
          keepSeen = keep;
          return Promise.resolve(7);
        },
      },
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      taskDefKeep: 5,
    });
    expect(await reconciler.pruneTaskDefinitions()).toEqual({ deregistered: 7, failed: 0 });
    expect(keepSeen).toBe(5);
  });

  it("is a no-op (and never throws) when the backend can't prune", async () => {
    const reconciler = new Reconciler({
      service: fakeService(),
      storage: await emptyStorage(),
      compute: inertCompute(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    expect(await reconciler.pruneTaskDefinitions()).toEqual({ deregistered: 0, failed: 0 });
  });

  it("counts a prune that throws as zero, logging it (best-effort)", async () => {
    const warnings: Record<string, unknown>[] = [];
    const reconciler = new Reconciler({
      service: fakeService(),
      storage: await emptyStorage(),
      compute: {
        ...inertCompute(),
        pruneTaskDefinitions: () => Promise.reject(new Error("AccessDenied")),
      },
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      logger: { warn: (_m, fields) => warnings.push(fields ?? {}) },
    });
    // A throwing prune must surface as `failed: 1` (NOT a success-shaped `deregistered: 0`)
    // so a persistent failure shows on the prune-failed metric/alarm instead of letting
    // task-def revisions grow unbounded in silence — the whole point of the sweep.
    expect(await reconciler.pruneTaskDefinitions()).toEqual({ deregistered: 0, failed: 1 });
    expect(warnings).toHaveLength(1);
  });
});

describe("Reconciler.detectStorageDrift (reverse drift: manually-deleted snapshot)", () => {
  it("marks a workspace error when its referenced snapshot is gone, spares present ones", async () => {
    const marked: string[] = [];
    const storage: StorageProvider = {
      ...(await emptyStorage()),
      listSnapshots: () =>
        Promise.resolve([
          {
            id: snapshotId("snap-present"),
            createdAt: isoTimestamp("2026-06-01T00:00:00.000Z"),
            sourceVolumeId: volumeId("vol-1"),
          },
        ]),
    };
    const reconciler = new Reconciler({
      service: fakeService({
        listSnapshotReferences: () =>
          Promise.resolve([
            { id: workspaceId("ws-ok"), snapshotId: snapshotId("snap-present") },
            { id: workspaceId("ws-gone"), snapshotId: snapshotId("snap-deleted") },
          ]),
        markSnapshotLostFor: (id) => {
          marked.push(id);
          return Promise.resolve({ ok: true as const, value: undefined });
        },
      }),
      storage,
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    expect(await reconciler.detectStorageDrift()).toEqual({
      scanned: 2,
      lost: 1,
      skipped: 0,
      failed: 0,
    });
    expect(marked).toEqual([workspaceId("ws-gone")]);
  });
});

describe("Reconciler.finishDeletions + recoverErrors (desired-state convergence)", () => {
  const ok = () => Promise.resolve({ ok: true as const, value: undefined });
  const conflict = () =>
    Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, reason: "x" } });
  const throws = () => Promise.reject(new Error("genuine teardown error"));

  it("finishes deleting tombstones: conflict race is skipped, a genuine throw is failed", async () => {
    // A non-ok Result is a benign version-conflict race (another pass converged it) → skipped,
    // NOT failed — counting it as failed would raise a false CONVERGE_FAILED alarm. Only a
    // thrown (genuine) error is a failure that's retried next sweep.
    const finished: string[] = [];
    const reconciler = new Reconciler({
      service: fakeService({
        listDeleting: () =>
          Promise.resolve([
            { id: workspaceId("ws-a") },
            { id: workspaceId("ws-conflict") },
            { id: workspaceId("ws-throw") },
          ]),
        finishDeleting: (id) => {
          if (id === workspaceId("ws-conflict")) return conflict();
          if (id === workspaceId("ws-throw")) return throws();
          finished.push(id);
          return ok();
        },
      }),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    expect(await reconciler.finishDeletions()).toEqual({
      scanned: 3,
      acted: 1,
      skipped: 1,
      failed: 1,
    });
    expect(finished).toEqual([workspaceId("ws-a")]);
  });

  it("recovers error workspaces: a conflict race is skipped, not a false failure", async () => {
    const recovered: string[] = [];
    const reconciler = new Reconciler({
      service: fakeService({
        listRecoverableErrors: () =>
          Promise.resolve([{ id: workspaceId("ws-err") }, { id: workspaceId("ws-raced") }]),
        recoverError: (id) => {
          if (id === workspaceId("ws-raced")) return conflict();
          recovered.push(id);
          return ok();
        },
      }),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    // The raced workspace must NOT count as failed (no false converge-failed alarm).
    expect(await reconciler.recoverErrors()).toEqual({
      scanned: 2,
      acted: 1,
      skipped: 1,
      failed: 0,
    });
    expect(recovered).toEqual([workspaceId("ws-err")]);
  });

  it("bounds each convergence sweep by the budget (converges over multiple sweeps)", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => ({ id: workspaceId(`ws-${i.toString()}`) }));
    const reconciler = new Reconciler({
      service: fakeService({ listDeleting: () => Promise.resolve(ids), finishDeleting: ok }),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      convergeBudget: 2,
    });
    expect(await reconciler.finishDeletions()).toEqual({
      scanned: 5,
      acted: 2,
      skipped: 0,
      failed: 0,
    });
  });
});

describe("Reconciler.recoverProvisioning", () => {
  it("reverts a wake stuck past the timeout and spares a fresh one", async () => {
    const recovered: string[] = [];
    const service = fakeService({
      listStuckProvisioning: () =>
        Promise.resolve([
          { id: workspaceId("ws-stuck"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
          { id: workspaceId("ws-fresh"), lastActivity: isoTimestamp("2026-06-01T01:59:00.000Z") },
        ]),
      recoverStuckProvisioning: (id) => {
        recovered.push(id);
        return Promise.resolve(ok(undefined));
      },
    });
    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      provisioningTimeoutMs: THIRTY_MIN,
    });

    expect(await reconciler.recoverProvisioning()).toEqual({
      scanned: 2,
      recovered: 1,
      skipped: 0,
      failed: 0,
    });
    expect(recovered).toEqual([workspaceId("ws-stuck")]);
  });

  it("skips (does not throw) a recovery that loses a state race", async () => {
    const service = fakeService({
      listStuckProvisioning: () =>
        Promise.resolve([
          { id: workspaceId("ws-stuck"), lastActivity: isoTimestamp("2026-06-01T00:00:00.000Z") },
        ]),
      // A slow wake committed → running before we reverted it.
      recoverStuckProvisioning: () => Promise.resolve(err(conflictError("won the wake"))),
    });
    const reconciler = new Reconciler({
      service,
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      provisioningTimeoutMs: THIRTY_MIN,
    });

    expect(await reconciler.recoverProvisioning()).toEqual({
      scanned: 1,
      recovered: 0,
      skipped: 1,
      failed: 0,
    });
  });
});

describe("Reconciler.reconcileOwnerCounts (quota drift self-heal)", () => {
  it("delegates to the control plane, returns the count, and warns when nonzero", async () => {
    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const reconciler = new Reconciler({
      service: fakeService({ reconcileOwnerCounts: () => Promise.resolve(3) }),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      logger: { warn: (message, fields) => warnings.push({ message, fields }) },
    });
    expect(await reconciler.reconcileOwnerCounts()).toBe(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ corrected: 3 });
  });

  it("is silent when there is no drift (returns 0, no warning)", async () => {
    const warnings: unknown[] = [];
    const reconciler = new Reconciler({
      service: fakeService({ reconcileOwnerCounts: () => Promise.resolve(0) }),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
      logger: { warn: (_m, fields) => warnings.push(fields) },
    });
    expect(await reconciler.reconcileOwnerCounts()).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it("runMaintenance surfaces the corrected count", async () => {
    const reconciler = new Reconciler({
      service: fakeService({ reconcileOwnerCounts: () => Promise.resolve(2) }),
      storage: await emptyStorage(),
      clock: fixedClock("2026-06-01T02:00:00.000Z"),
    });
    expect((await reconciler.runMaintenance()).quotaDriftCorrected).toBe(2);
  });
});

describe("Reconciler.controlPlaneIdleShutdown", () => {
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const NOW = "2026-06-01T02:00:00.000Z";

  /** A control-plane scaler/activity config wired to a spy that records scale calls. */
  function cpConfig(opts: {
    desiredCount: number;
    lastActivityAt: string | undefined;
    scaled: [string, number][];
    describeThrows?: boolean;
  }): ControlPlaneScaleConfig {
    return {
      serviceName: "edd-prod-control-plane",
      idleThresholdMs: FIFTEEN_MIN,
      scaler: {
        describeService: (_s) =>
          opts.describeThrows === true
            ? Promise.reject(new Error("no active service 'edd-prod-control-plane'"))
            : Promise.resolve({ desiredCount: opts.desiredCount, runningCount: opts.desiredCount }),
        scaleService: (s, n) => {
          opts.scaled.push([s, n]);
          return Promise.resolve();
        },
      },
      activity: {
        readLastActivity: () =>
          Promise.resolve(
            opts.lastActivityAt === undefined ? undefined : isoTimestamp(opts.lastActivityAt),
          ),
      },
    };
  }

  async function run(controlPlane: ControlPlaneScaleConfig | undefined) {
    const reconciler = new Reconciler({
      service: fakeService(),
      storage: await emptyStorage(),
      clock: fixedClock(isoTimestamp(NOW)),
      ...(controlPlane === undefined ? {} : { controlPlane }),
    });
    return (await reconciler.runMaintenance()).controlPlane;
  }

  it("scales the control-plane service to zero once idle past the threshold", async () => {
    const scaled: [string, number][] = [];
    const result = await run(
      cpConfig({ desiredCount: 2, lastActivityAt: "2026-06-01T01:30:00.000Z", scaled }),
    );
    expect(result).toMatchObject({
      configured: true,
      desiredCount: 2,
      scaledToZero: true,
      failed: 0,
    });
    expect(scaled).toEqual([["edd-prod-control-plane", 0]]);
  });

  it("holds (no scale) while the control plane is still within the idle window", async () => {
    const scaled: [string, number][] = [];
    const result = await run(
      cpConfig({ desiredCount: 2, lastActivityAt: "2026-06-01T01:59:00.000Z", scaled }),
    );
    expect(result).toMatchObject({ configured: true, scaledToZero: false, failed: 0 });
    expect(scaled).toEqual([]);
  });

  it("holds during startup grace (no activity recorded yet) — never kills a waking CP", async () => {
    const scaled: [string, number][] = [];
    const result = await run(cpConfig({ desiredCount: 2, lastActivityAt: undefined, scaled }));
    expect(result.scaledToZero).toBe(false);
    expect(scaled).toEqual([]);
  });

  it("is a no-op when control-plane scaling is not configured", async () => {
    const result = await run(undefined);
    expect(result).toEqual({
      configured: false,
      desiredCount: 0,
      scaledToZero: false,
      reason: "unconfigured",
      failed: 0,
    });
  });

  it("isolates a thrown describeService — counts a failure, never aborts the sweep", async () => {
    const scaled: [string, number][] = [];
    const result = await run(
      cpConfig({
        desiredCount: 2,
        lastActivityAt: "2026-06-01T01:00:00.000Z",
        scaled,
        describeThrows: true,
      }),
    );
    expect(result).toMatchObject({
      configured: true,
      scaledToZero: false,
      failed: 1,
      reason: "error",
    });
    expect(scaled).toEqual([]);
  });
});
