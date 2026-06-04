// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_GC_GRACE_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  isoTimestamp,
  selectDueForSnapshot,
  selectOrphanSnapshots,
  selectOrphanVolumes,
  type Clock,
  type DomainError,
  type IsoTimestamp,
  type ReferencedStorage,
  type Result,
  type SnapshotCandidate,
  type StorageProvider,
  type WorkspaceId,
} from "@edd/core";

/** An active workspace the reconciler may scale to zero. */
export interface ActiveWorkspace {
  id: WorkspaceId;
  lastActivity: IsoTimestamp;
}

/**
 * The control-plane operations the reconciler drives. A port (not the concrete
 * `WorkspaceService`) so the reconciler is decoupled and unit-testable with a
 * fake; `WorkspaceService` satisfies it structurally.
 */
export interface ReconcilerService {
  listActive(): Promise<readonly ActiveWorkspace[]>;
  /** Scale to zero. Returns a typed Result so a benign race (the workspace
   * changed state since it was listed) is skipped, not thrown — see `runOnce`. */
  stop(id: WorkspaceId): Promise<Result<unknown, DomainError>>;
  /** Workspaces with a live volume, eligible for a scheduled snapshot. */
  listSnapshotCandidates(): Promise<readonly SnapshotCandidate[]>;
  /** Take a point-in-time snapshot of a running workspace. */
  snapshot(id: WorkspaceId): Promise<Result<unknown, DomainError>>;
  /** Storage ids still referenced by a workspace — never garbage-collected. */
  listReferencedStorage(): Promise<ReferencedStorage>;
}

/** Pure: the ids of workspaces idle for at least `idleThresholdMs`. */
export function selectIdle(
  active: readonly ActiveWorkspace[],
  now: IsoTimestamp,
  idleThresholdMs: number,
): WorkspaceId[] {
  const nowMs = Date.parse(now);
  return active
    .filter((w) => nowMs - Date.parse(w.lastActivity) >= idleThresholdMs)
    .map((w) => w.id);
}

export interface ReconcilerDeps {
  service: ReconcilerService;
  /** Storage port used to enumerate and reap orphaned volumes/snapshots. */
  storage: StorageProvider;
  clock: Clock;
  /** Idle window before scale-to-zero; defaults to `DEFAULT_IDLE_THRESHOLD_MS`. */
  idleThresholdMs?: number;
  /** Interval between scheduled snapshots; defaults to `DEFAULT_SNAPSHOT_INTERVAL_MS`. */
  snapshotIntervalMs?: number;
  /** Grace window before an orphan is reaped; defaults to `DEFAULT_GC_GRACE_MS`. */
  gcGraceMs?: number;
}

export interface ReconcileResult {
  scanned: number;
  stopped: number;
  /** Eligible workspaces whose stop was rejected by a state race (skipped, not failed). */
  skipped: number;
}

export interface SnapshotResult {
  scanned: number;
  snapshotted: number;
  /** Eligible workspaces whose snapshot was rejected by a state race. */
  skipped: number;
}

export interface GcResult {
  volumesDeleted: number;
  snapshotsDeleted: number;
}

export interface MaintenanceResult {
  idle: ReconcileResult;
  snapshots: SnapshotResult;
  gc: GcResult;
}

/**
 * Imperative shell: gather state, decide what to do (pure `@edd/core` functions),
 * then perform the effects through the control-plane and storage ports.
 */
export class Reconciler {
  private readonly idleThresholdMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly gcGraceMs: number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.gcGraceMs = deps.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
  }

  private now(): IsoTimestamp {
    return isoTimestamp(this.deps.clock.now());
  }

  /** Scale idle workspaces to zero (snapshot + tear down). A stop rejected by a
   * state race (e.g. the user woke it since it was listed) is skipped and
   * counted, not thrown — one racy workspace must not abort the sweep. */
  async runOnce(): Promise<ReconcileResult> {
    const active = await this.deps.service.listActive();
    const toStop = selectIdle(active, this.now(), this.idleThresholdMs);
    let stopped = 0;
    let skipped = 0;
    for (const id of toStop) {
      if ((await this.deps.service.stop(id)).ok) stopped += 1;
      else skipped += 1;
    }
    return { scanned: active.length, stopped, skipped };
  }

  /** Take scheduled point-in-time snapshots of workspaces past the interval. */
  async snapshotDue(): Promise<SnapshotResult> {
    const candidates = await this.deps.service.listSnapshotCandidates();
    const due = selectDueForSnapshot(candidates, this.now(), this.snapshotIntervalMs);
    let snapshotted = 0;
    let skipped = 0;
    for (const id of due) {
      if ((await this.deps.service.snapshot(id)).ok) snapshotted += 1;
      else skipped += 1;
    }
    return { scanned: candidates.length, snapshotted, skipped };
  }

  /**
   * Delete volumes/snapshots no workspace references and older than the grace
   * window. The control plane is the source of truth for what is referenced;
   * the storage provider for what exists. (Only the latest snapshot per
   * workspace is referenced, so superseded snapshots are reaped here.)
   */
  async collectGarbage(): Promise<GcResult> {
    const { volumeIds, snapshotIds } = await this.deps.service.listReferencedStorage();
    const now = this.now();
    const [volumes, snapshots] = await Promise.all([
      this.deps.storage.listVolumes(),
      this.deps.storage.listSnapshots(),
    ]);

    const orphanVolumes = selectOrphanVolumes(volumes, new Set(volumeIds), now, this.gcGraceMs);
    const orphanSnapshots = selectOrphanSnapshots(
      snapshots,
      new Set(snapshotIds),
      now,
      this.gcGraceMs,
    );

    for (const id of orphanVolumes) await this.deps.storage.deleteVolume(id);
    for (const id of orphanSnapshots) await this.deps.storage.deleteSnapshot(id);

    return { volumesDeleted: orphanVolumes.length, snapshotsDeleted: orphanSnapshots.length };
  }

  /** One full maintenance sweep: scale-to-zero, scheduled snapshots, then GC. */
  async runMaintenance(): Promise<MaintenanceResult> {
    const idle = await this.runOnce();
    const snapshots = await this.snapshotDue();
    const gc = await this.collectGarbage();
    return { idle, snapshots, gc };
  }
}
