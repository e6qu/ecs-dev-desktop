// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceTaskRef } from "../compute/compute-provider";
import type { IsoTimestamp, SnapshotId, TaskId, VolumeId, WorkspaceId } from "../domain/ids";
import type { SnapshotRef, VolumeRef } from "../storage/storage-provider";

/**
 * The maintenance functional core: pure decisions for orphan garbage collection
 * and scheduled point-in-time snapshots. Data in, ids out — no I/O. The
 * reconciler shell enumerates resources, calls these, then performs the effects.
 */

/** A workspace with a live volume, considered for a scheduled snapshot. */
export interface SnapshotCandidate {
  readonly id: WorkspaceId;
  /** When the workspace was last snapshotted; absent if never. */
  readonly latestSnapshotAt?: IsoTimestamp;
}

/** The storage ids still referenced by live workspaces (must never be GC'd). */
export interface ReferencedStorage {
  readonly volumeIds: readonly VolumeId[];
  readonly snapshotIds: readonly SnapshotId[];
}

function olderThan(createdAt: IsoTimestamp, now: IsoTimestamp, ms: number): boolean {
  return Date.parse(now) - Date.parse(createdAt) >= ms;
}

/**
 * Volumes safe to delete: not referenced by any live workspace AND older than
 * `graceMs`. The grace window guards against reaping a volume created moments ago
 * but not yet recorded in the control plane (a create/persist race).
 */
export function selectOrphanVolumes(
  existing: readonly VolumeRef[],
  referenced: ReadonlySet<VolumeId>,
  now: IsoTimestamp,
  graceMs: number,
): VolumeId[] {
  return existing
    .filter((v) => !referenced.has(v.id) && olderThan(v.createdAt, now, graceMs))
    .map((v) => v.id);
}

/** Snapshots safe to delete — the snapshot analogue of {@link selectOrphanVolumes}. */
export function selectOrphanSnapshots(
  existing: readonly SnapshotRef[],
  referenced: ReadonlySet<SnapshotId>,
  now: IsoTimestamp,
  graceMs: number,
): SnapshotId[] {
  return existing
    .filter((s) => !referenced.has(s.id) && olderThan(s.createdAt, now, graceMs))
    .map((s) => s.id);
}

/**
 * Workspace tasks safe to stop: RUNNING tasks this platform launched whose workspace
 * no longer references them (the record was deleted, never persisted, or points at a
 * different task) AND that started at least `graceMs` ago. The grace window guards the
 * same create/persist race as {@link selectOrphanVolumes} — a task launched moments
 * ago but not yet recorded must not be reaped. The compute analogue of orphan-volume GC.
 */
export function selectOrphanTasks(
  existing: readonly WorkspaceTaskRef[],
  referenced: ReadonlySet<TaskId>,
  now: IsoTimestamp,
  graceMs: number,
): readonly WorkspaceTaskRef[] {
  return existing.filter((t) => !referenced.has(t.id) && olderThan(t.startedAt, now, graceMs));
}

/**
 * Workspaces due for a point-in-time snapshot: never snapshotted, or last
 * snapshotted at least `intervalMs` ago.
 */
export function selectDueForSnapshot(
  candidates: readonly SnapshotCandidate[],
  now: IsoTimestamp,
  intervalMs: number,
): WorkspaceId[] {
  return candidates
    .filter(
      (c) => c.latestSnapshotAt === undefined || olderThan(c.latestSnapshotAt, now, intervalMs),
    )
    .map((c) => c.id);
}
