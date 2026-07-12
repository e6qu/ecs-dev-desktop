// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceAgentSecretRef, WorkspaceTaskRef } from "../compute/compute-provider";
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
  /** When the workspace was created; enables the shorter early-session cadence. */
  readonly createdAt?: IsoTimestamp;
  /** Per-workspace scheduled snapshot cadence. Absent means the deployment default. */
  readonly snapshotIntervalMs?: number;
}

/** The storage ids still referenced by live workspaces (must never be GC'd). */
export interface ReferencedStorage {
  readonly volumeIds: readonly VolumeId[];
  readonly snapshotIds: readonly SnapshotId[];
}

/**
 * Every keep-set the maintenance reapers/GC need, derived from ONE workspace-table scan
 * (storage refs + task refs + secret-owning workspace ids). The reconciler's maintenance
 * tick reaps orphan tasks, orphan secrets, and orphan storage back-to-back; computing all
 * three keep-sets from a single scan avoids three full-table scans per tick.
 */
export interface FleetReferences extends ReferencedStorage {
  /** Task ids a workspace record still names — the orphan-task reaper's keep-set. */
  readonly taskIds: readonly TaskId[];
  /** Ids of workspaces that still reference a runtime task — the secret reaper's keep-set. */
  readonly secretWorkspaceIds: readonly WorkspaceId[];
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

/**
 * Snapshots safe to delete — the snapshot analogue of {@link selectOrphanVolumes},
 * with one extra guard: a snapshot marked `retained` (the Middle policy's
 * data-safety keep taken at teardown) is NEVER reaped, regardless of the grace
 * window, so a deleted workspace's final snapshot survives orphan GC.
 */
export function selectOrphanSnapshots(
  existing: readonly SnapshotRef[],
  referenced: ReadonlySet<SnapshotId>,
  now: IsoTimestamp,
  graceMs: number,
): SnapshotId[] {
  return existing
    .filter(
      (s) => s.retained !== true && !referenced.has(s.id) && olderThan(s.createdAt, now, graceMs),
    )
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
 * Per-workspace agent secrets to reap: those whose workspace id no longer exists
 * (the record was deleted, so the secret leaks) AND created at least `graceMs` ago.
 * The grace window guards the create/persist race (a secret created moments ago for
 * a workspace whose record isn't yet visible must not be reaped). The
 * secrets-manager analogue of orphan-volume/-task GC.
 */
export function selectOrphanSecrets(
  existing: readonly WorkspaceAgentSecretRef[],
  liveWorkspaceIds: ReadonlySet<WorkspaceId>,
  now: IsoTimestamp,
  graceMs: number,
): readonly WorkspaceAgentSecretRef[] {
  return existing.filter(
    (s) => !liveWorkspaceIds.has(s.workspaceId) && olderThan(s.createdAt, now, graceMs),
  );
}

/**
 * Workspaces due for a point-in-time snapshot. A workspace that has NEVER been
 * snapshotted is always due, so a fresh session gets a recoverable point on the very
 * next sweep rather than after a full interval. Otherwise it is due when its last
 * snapshot is older than the applicable interval: a YOUNG workspace (created within
 * `early.sessionMs`) uses the shorter `early.intervalMs` so a new session's work is
 * captured frequently before the workspace settles onto the steady-state `intervalMs`.
 * `early` is optional — omit it to use a single interval for all candidates.
 */
export function selectDueForSnapshot(
  candidates: readonly SnapshotCandidate[],
  now: IsoTimestamp,
  intervalMs: number,
  early?: { readonly intervalMs: number; readonly sessionMs: number },
): WorkspaceId[] {
  return candidates
    .filter((c) => {
      if (c.latestSnapshotAt === undefined) return true;
      const isYoung =
        early !== undefined &&
        c.createdAt !== undefined &&
        !olderThan(c.createdAt, now, early.sessionMs);
      const earlyIntervalMs = early === undefined ? undefined : early.intervalMs;
      const effectiveIntervalMs =
        c.snapshotIntervalMs ?? (isYoung ? earlyIntervalMs : undefined) ?? intervalMs;
      return olderThan(c.latestSnapshotAt, now, effectiveIntervalMs);
    })
    .map((c) => c.id);
}
