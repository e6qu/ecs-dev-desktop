// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { WorkspaceTaskRef } from "../compute/compute-provider";
import { isoTimestamp, snapshotId, taskId, volumeId, workspaceId } from "../domain/ids";
import type { SnapshotRef, VolumeRef } from "../storage/storage-provider";
import {
  selectDueForSnapshot,
  selectOrphanSecrets,
  selectOrphanSnapshots,
  selectOrphanTasks,
  selectOrphanVolumes,
  type SnapshotCandidate,
} from "./select";

const now = isoTimestamp("2026-06-01T12:00:00.000Z");
const old = isoTimestamp("2026-06-01T00:00:00.000Z"); // 12h before now
const recent = isoTimestamp("2026-06-01T11:59:00.000Z"); // 1m before now
const exactGrace = isoTimestamp("2026-06-01T11:00:00.000Z"); // exactly ONE_HOUR before now
const ONE_HOUR = 60 * 60 * 1000;

describe("selectOrphanVolumes", () => {
  it("reaps unreferenced volumes past the grace window only", () => {
    const existing: VolumeRef[] = [
      { id: volumeId("vol-referenced"), createdAt: old },
      { id: volumeId("vol-orphan-old"), createdAt: old },
      { id: volumeId("vol-orphan-fresh"), createdAt: recent },
    ];
    const referenced = new Set([volumeId("vol-referenced")]);

    expect(selectOrphanVolumes(existing, referenced, now, ONE_HOUR)).toEqual([
      volumeId("vol-orphan-old"),
    ]);
  });

  it("never reaps a referenced volume even when old", () => {
    const existing: VolumeRef[] = [{ id: volumeId("vol-1"), createdAt: old }];
    expect(selectOrphanVolumes(existing, new Set([volumeId("vol-1")]), now, ONE_HOUR)).toEqual([]);
  });

  it("returns nothing for an empty volume list", () => {
    expect(selectOrphanVolumes([], new Set([volumeId("vol-1")]), now, ONE_HOUR)).toEqual([]);
  });

  it("reaps an old orphan when nothing is referenced", () => {
    const existing: VolumeRef[] = [{ id: volumeId("vol-1"), createdAt: old }];
    expect(selectOrphanVolumes(existing, new Set(), now, ONE_HOUR)).toEqual([volumeId("vol-1")]);
  });

  it("reaps a volume aged exactly the grace window (>= boundary)", () => {
    const existing: VolumeRef[] = [{ id: volumeId("vol-edge"), createdAt: exactGrace }];
    expect(selectOrphanVolumes(existing, new Set(), now, ONE_HOUR)).toEqual([volumeId("vol-edge")]);
  });
});

describe("selectOrphanSnapshots", () => {
  it("reaps unreferenced snapshots past the grace window only", () => {
    const existing: SnapshotRef[] = [
      { id: snapshotId("snap-latest"), createdAt: old, sourceVolumeId: volumeId("vol-1") },
      { id: snapshotId("snap-superseded"), createdAt: old, sourceVolumeId: volumeId("vol-1") },
      { id: snapshotId("snap-fresh"), createdAt: recent, sourceVolumeId: volumeId("vol-1") },
    ];
    const referenced = new Set([snapshotId("snap-latest")]);

    expect(selectOrphanSnapshots(existing, referenced, now, ONE_HOUR)).toEqual([
      snapshotId("snap-superseded"),
    ]);
  });

  it("never reaps a retained snapshot, even unreferenced and past grace (Middle policy)", () => {
    const existing: SnapshotRef[] = [
      // The teardown data-safety keep: unreferenced (its workspace record is gone)
      // and old, but retained — must survive GC.
      {
        id: snapshotId("snap-retained"),
        createdAt: old,
        sourceVolumeId: volumeId("vol-1"),
        retained: true,
      },
      { id: snapshotId("snap-orphan"), createdAt: old, sourceVolumeId: volumeId("vol-2") },
    ];

    expect(selectOrphanSnapshots(existing, new Set(), now, ONE_HOUR)).toEqual([
      snapshotId("snap-orphan"),
    ]);
  });
});

describe("selectDueForSnapshot", () => {
  it("selects workspaces never snapshotted or snapshotted before the interval", () => {
    const candidates: SnapshotCandidate[] = [
      { id: workspaceId("ws-never") },
      { id: workspaceId("ws-stale"), latestSnapshotAt: old },
      { id: workspaceId("ws-fresh"), latestSnapshotAt: recent },
    ];

    expect(selectDueForSnapshot(candidates, now, ONE_HOUR)).toEqual([
      workspaceId("ws-never"),
      workspaceId("ws-stale"),
    ]);
  });

  it("returns nothing for an empty candidate list", () => {
    expect(selectDueForSnapshot([], now, ONE_HOUR)).toEqual([]);
  });

  it("treats a workspace snapshotted exactly the interval ago as due (>= boundary)", () => {
    const candidates: SnapshotCandidate[] = [
      { id: workspaceId("ws-edge"), latestSnapshotAt: exactGrace },
    ];
    expect(selectDueForSnapshot(candidates, now, ONE_HOUR)).toEqual([workspaceId("ws-edge")]);
  });

  it("snapshots a YOUNG workspace on the shorter early cadence, an established one on the normal interval", () => {
    const TEN_MIN = 10 * 60 * 1000;
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const fifteenMinAgo = isoTimestamp("2026-06-01T11:45:00.000Z"); // > 10m, < 1h
    const candidates: SnapshotCandidate[] = [
      // created 1m ago (young) + last snapshot 15m ago → due on the 10m early cadence
      { id: workspaceId("ws-young"), createdAt: recent, latestSnapshotAt: fifteenMinAgo },
      // created 12h ago (established) + last snapshot 15m ago → NOT due on the 1h interval
      { id: workspaceId("ws-old"), createdAt: old, latestSnapshotAt: fifteenMinAgo },
    ];
    expect(
      selectDueForSnapshot(candidates, now, ONE_HOUR, {
        intervalMs: TEN_MIN,
        sessionMs: TWO_HOURS,
      }),
    ).toEqual([workspaceId("ws-young")]);
  });

  it("never-snapshotted is due even when young (first recoverable point ASAP)", () => {
    const candidates: SnapshotCandidate[] = [{ id: workspaceId("ws-new"), createdAt: recent }];
    expect(
      selectDueForSnapshot(candidates, now, ONE_HOUR, {
        intervalMs: 10 * 60 * 1000,
        sessionMs: 2 * 60 * 60 * 1000,
      }),
    ).toEqual([workspaceId("ws-new")]);
  });

  it("without an early cadence, a young workspace uses the single interval (back-compat)", () => {
    const fifteenMinAgo = isoTimestamp("2026-06-01T11:45:00.000Z");
    const candidates: SnapshotCandidate[] = [
      { id: workspaceId("ws-young"), createdAt: recent, latestSnapshotAt: fifteenMinAgo },
    ];
    expect(selectDueForSnapshot(candidates, now, ONE_HOUR)).toEqual([]);
  });

  it("uses a per-workspace interval before the global interval", () => {
    const fifteenMinAgo = isoTimestamp("2026-06-01T11:45:00.000Z");
    const candidates: SnapshotCandidate[] = [
      {
        id: workspaceId("ws-custom"),
        latestSnapshotAt: fifteenMinAgo,
        snapshotIntervalMs: 10 * 60 * 1000,
      },
      { id: workspaceId("ws-global"), latestSnapshotAt: fifteenMinAgo },
    ];
    expect(selectDueForSnapshot(candidates, now, ONE_HOUR)).toEqual([workspaceId("ws-custom")]);
  });
});

describe("selectOrphanTasks", () => {
  const taskRef = (id: string, ws: string, startedAt = old): WorkspaceTaskRef => ({
    id: taskId(id),
    workspaceId: workspaceId(ws),
    startedAt,
  });

  it("reaps a tagged task no record references, past the grace window", () => {
    const existing = [taskRef("task-orphan", "ws-1"), taskRef("task-kept", "ws-2")];
    const referenced = new Set([taskId("task-kept")]);
    expect(selectOrphanTasks(existing, referenced, now, ONE_HOUR)).toEqual([
      taskRef("task-orphan", "ws-1"),
    ]);
  });

  it("spares a referenced task even past the grace window", () => {
    const existing = [taskRef("task-kept", "ws-2")];
    expect(selectOrphanTasks(existing, new Set([taskId("task-kept")]), now, ONE_HOUR)).toEqual([]);
  });

  it("spares an unreferenced task still inside the grace window (create/persist race)", () => {
    const existing = [taskRef("task-fresh", "ws-3", recent)];
    expect(selectOrphanTasks(existing, new Set(), now, ONE_HOUR)).toEqual([]);
  });

  it("reaps a task started exactly the grace ago (>= boundary)", () => {
    const existing = [taskRef("task-edge", "ws-4", exactGrace)];
    expect(selectOrphanTasks(existing, new Set(), now, ONE_HOUR)).toEqual([
      taskRef("task-edge", "ws-4", exactGrace),
    ]);
  });
});

describe("snapshot retention after shutdown", () => {
  it("keeps only the shutdown snapshot after the one-hour GC grace", () => {
    const shutdownSnapshot = snapshotId("snap-shutdown");
    const oldScheduled = snapshotId("snap-old-scheduled");
    const newerScheduled = snapshotId("snap-newer-scheduled");
    const twoHoursAfterShutdown = isoTimestamp("2026-06-01T14:00:00.000Z");

    expect(
      selectOrphanSnapshots(
        [
          {
            id: oldScheduled,
            sourceVolumeId: volumeId("vol-ws"),
            createdAt: isoTimestamp("2026-06-01T11:00:00.000Z"),
          },
          {
            id: newerScheduled,
            sourceVolumeId: volumeId("vol-ws"),
            createdAt: isoTimestamp("2026-06-01T11:55:00.000Z"),
          },
          {
            id: shutdownSnapshot,
            sourceVolumeId: volumeId("vol-ws"),
            createdAt: isoTimestamp("2026-06-01T12:00:00.000Z"),
          },
        ],
        new Set([shutdownSnapshot]),
        twoHoursAfterShutdown,
        ONE_HOUR,
      ),
    ).toEqual([oldScheduled, newerScheduled]);
  });
});

describe("selectOrphanSecrets", () => {
  const secretRef = (ws: string, createdAt = old) => ({
    name: `edd/workspace/${ws}/agent`,
    workspaceId: workspaceId(ws),
    createdAt,
  });

  it("reaps a secret whose workspace is gone, past the grace window", () => {
    const existing = [secretRef("ws-dead"), secretRef("ws-live")];
    const live = new Set([workspaceId("ws-live")]);
    expect(selectOrphanSecrets(existing, live, now, ONE_HOUR)).toEqual([secretRef("ws-dead")]);
  });

  it("spares a secret whose workspace still exists, even when old", () => {
    const existing = [secretRef("ws-live")];
    expect(selectOrphanSecrets(existing, new Set([workspaceId("ws-live")]), now, ONE_HOUR)).toEqual(
      [],
    );
  });

  it("spares an orphan secret still inside the grace window (create/persist race)", () => {
    const existing = [secretRef("ws-fresh", recent)];
    expect(selectOrphanSecrets(existing, new Set(), now, ONE_HOUR)).toEqual([]);
  });
});
