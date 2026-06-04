// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  conflictError,
  err,
  FakeStorageProvider,
  fixedClock,
  isoTimestamp,
  ok,
  workspaceId,
  type StorageProvider,
} from "@edd/core";
import { describe, expect, it } from "vitest";

import { Reconciler, selectIdle, type ActiveWorkspace, type ReconcilerService } from "./index";

const THIRTY_MIN = 30 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** A ReconcilerService whose methods all no-op; override per test. */
function fakeService(overrides: Partial<ReconcilerService> = {}): ReconcilerService {
  return {
    listActive: () => Promise.resolve([]),
    stop: () => Promise.reject(new Error("stop not expected")),
    listSnapshotCandidates: () => Promise.resolve([]),
    snapshot: () => Promise.reject(new Error("snapshot not expected")),
    listReferencedStorage: () => Promise.resolve({ volumeIds: [], snapshotIds: [] }),
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

    expect(await reconciler.collectGarbage()).toEqual({ volumesDeleted: 1, snapshotsDeleted: 1 });
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

    expect(await reconciler.collectGarbage()).toEqual({ volumesDeleted: 0, snapshotsDeleted: 0 });
    expect((await storage.listVolumes()).map((v) => v.id)).toEqual([orphan.id]);
  });
});
