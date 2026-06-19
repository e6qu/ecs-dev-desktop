// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_EARLY_SESSION_MS,
  DEFAULT_EARLY_SNAPSHOT_INTERVAL_MS,
  DEFAULT_GC_GRACE_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_PROVISIONING_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  isoTimestamp,
  selectDueForSnapshot,
  selectOrphanSnapshots,
  selectOrphanTasks,
  selectOrphanVolumes,
  type Clock,
  type ComputeProvider,
  type DomainError,
  type IsoTimestamp,
  type ReferencedStorage,
  type Result,
  type SnapshotCandidate,
  type StorageProvider,
  type TaskId,
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
  /** Drift detection: reconcile a record whose task died out-of-band. */
  reconcileTaskLoss(
    id: WorkspaceId,
  ): Promise<Result<{ lost: boolean; workspace: unknown }, DomainError>>;
  /** Scale to zero. Returns a typed Result so a benign race (the workspace
   * changed state since it was listed) is skipped, not thrown — see `runOnce`. */
  stop(id: WorkspaceId): Promise<Result<unknown, DomainError>>;
  /** Workspaces with a live volume, eligible for a scheduled snapshot. */
  listSnapshotCandidates(): Promise<readonly SnapshotCandidate[]>;
  /** Take a point-in-time snapshot of a running workspace. */
  snapshot(id: WorkspaceId): Promise<Result<unknown, DomainError>>;
  /** Storage ids still referenced by a workspace — never garbage-collected. */
  listReferencedStorage(): Promise<ReferencedStorage>;
  /** Task ids still referenced by a workspace record — the orphan-task reaper's
   * keep-set (a RUNNING workspace task in none of these is an orphan). */
  listReferencedTasks(): Promise<readonly TaskId[]>;
  /** Workspaces sitting in `provisioning` (claim time as `lastActivity`) — candidates
   * for stuck-wake recovery. */
  listStuckProvisioning(): Promise<readonly ActiveWorkspace[]>;
  /** Revert a workspace whose wake crashed mid-flight (stuck `provisioning`) to
   * `stopped`. Returns a Result so a benign race (a slow wake that finally committed)
   * is skipped, not thrown. */
  recoverStuckProvisioning(id: WorkspaceId): Promise<Result<unknown, DomainError>>;
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

/** Minimal logging port — `@edd/core`'s `createLogger` satisfies it structurally.
 * Used to surface best-effort GC delete failures loudly (not swallowed). */
export interface ReconcilerLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ReconcilerDeps {
  service: ReconcilerService;
  /** Storage port used to enumerate and reap orphaned volumes/snapshots. */
  storage: StorageProvider;
  /** Compute port used to enumerate + stop orphaned workspace tasks (self-healing).
   * Optional — absent, or a provider without `listWorkspaceTasks`, ⇒ no task reaping. */
  compute?: ComputeProvider;
  clock: Clock;
  /** Optional logger; GC delete and orphan-task stop failures are logged through it. */
  logger?: ReconcilerLogger;
  /** Idle window before scale-to-zero; defaults to `DEFAULT_IDLE_THRESHOLD_MS`. */
  idleThresholdMs?: number;
  /** Interval between scheduled snapshots; defaults to `DEFAULT_SNAPSHOT_INTERVAL_MS`. */
  snapshotIntervalMs?: number;
  /** Shorter snapshot interval for a young workspace; defaults to `DEFAULT_EARLY_SNAPSHOT_INTERVAL_MS`. */
  earlySnapshotIntervalMs?: number;
  /** How long a workspace stays on the early snapshot cadence; defaults to `DEFAULT_EARLY_SESSION_MS`. */
  earlySessionMs?: number;
  /** Grace window before an orphan is reaped; defaults to `DEFAULT_GC_GRACE_MS`. */
  gcGraceMs?: number;
  /** How long a record may sit in `provisioning` before its crashed wake is reverted
   * to `stopped`; defaults to `DEFAULT_PROVISIONING_TIMEOUT_MS`. */
  provisioningTimeoutMs?: number;
}

export interface DriftResult {
  scanned: number;
  /** Records whose task was gone; transitioned to stopped (snapshot) or error. */
  lost: number;
  /** Reconciles rejected by a concurrent update (skipped, not failed). */
  skipped: number;
}

export interface ProvisioningResult {
  /** Records sitting in `provisioning`. */
  scanned: number;
  /** Stuck wakes reverted to `stopped` (self-healed). */
  recovered: number;
  /** Reverts rejected by a concurrent update — a slow wake that finally committed. */
  skipped: number;
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
  /** Orphan deletes that errored (e.g. a volume transiently in-use). GC is
   * best-effort per resource — these are counted and logged, not thrown. */
  volumesFailed: number;
  snapshotsFailed: number;
}

export interface ReapResult {
  /** Tagged, RUNNING workspace tasks enumerated. */
  scanned: number;
  /** Orphaned tasks stopped — no workspace record referenced them (self-healed). */
  reaped: number;
  /** Orphan stops that errored — best-effort, counted and logged, not thrown. */
  failed: number;
}

export interface MaintenanceResult {
  provisioning: ProvisioningResult;
  drift: DriftResult;
  idle: ReconcileResult;
  snapshots: SnapshotResult;
  tasks: ReapResult;
  gc: GcResult;
}

/**
 * Imperative shell: gather state, decide what to do (pure `@edd/core` functions),
 * then perform the effects through the control-plane and storage ports.
 */
export class Reconciler {
  private readonly idleThresholdMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly earlySnapshotIntervalMs: number;
  private readonly earlySessionMs: number;
  private readonly gcGraceMs: number;
  private readonly provisioningTimeoutMs: number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.earlySnapshotIntervalMs =
      deps.earlySnapshotIntervalMs ?? DEFAULT_EARLY_SNAPSHOT_INTERVAL_MS;
    this.earlySessionMs = deps.earlySessionMs ?? DEFAULT_EARLY_SESSION_MS;
    this.gcGraceMs = deps.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.provisioningTimeoutMs = deps.provisioningTimeoutMs ?? DEFAULT_PROVISIONING_TIMEOUT_MS;
  }

  private now(): IsoTimestamp {
    return isoTimestamp(this.deps.clock.now());
  }

  /**
   * Drift sweep: notice tasks that died out-of-band (crash, eviction, manual
   * stop) and stop their records advertising live bindings. MUST run before
   * the idle sweep — stop() on a drifted record would try to snapshot a
   * volume the platform already released with the dead task.
   */
  async detectDrift(): Promise<DriftResult> {
    const active = await this.deps.service.listActive();
    let lost = 0;
    let skipped = 0;
    for (const ws of active) {
      const result = await this.deps.service.reconcileTaskLoss(ws.id);
      if (!result.ok) skipped += 1;
      else if (result.value.lost) lost += 1;
    }
    return { scanned: active.length, lost, skipped };
  }

  /**
   * Self-heal crashed wakes: revert records stuck in `provisioning` past the timeout
   * back to `stopped` so they are wake-able again. A wake claims `stopped →
   * provisioning` then commits `→ running`; if the driving process dies between, the
   * record is stranded forever (no sweep touches `provisioning`). Reuses the same
   * "older-than" age filter as the idle sweep; the revert is best-effort and a lost
   * race (a slow wake that finally committed) is skipped, not failed. MUST run first —
   * before any other sweep can act on a half-woken record.
   */
  async recoverProvisioning(): Promise<ProvisioningResult> {
    const candidates = await this.deps.service.listStuckProvisioning();
    const stuck = selectIdle(candidates, this.now(), this.provisioningTimeoutMs);
    let recovered = 0;
    let skipped = 0;
    for (const id of stuck) {
      if ((await this.deps.service.recoverStuckProvisioning(id)).ok) recovered += 1;
      else skipped += 1;
    }
    return { scanned: candidates.length, recovered, skipped };
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
    const due = selectDueForSnapshot(candidates, this.now(), this.snapshotIntervalMs, {
      intervalMs: this.earlySnapshotIntervalMs,
      sessionMs: this.earlySessionMs,
    });
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

    // Best-effort per resource: one delete that errors (e.g. a volume transiently
    // in-use, throttling, or already gone) must not strand the remaining orphans or
    // abort the sweep — the same resilience the idle/snapshot/drift sweeps have. The
    // error is counted and logged (not swallowed), and a persistent failure surfaces
    // as a non-zero `reconciler.gc.failed` metric.
    let volumesDeleted = 0;
    let volumesFailed = 0;
    for (const id of orphanVolumes) {
      try {
        await this.deps.storage.deleteVolume(id);
        volumesDeleted += 1;
      } catch (err) {
        volumesFailed += 1;
        this.deps.logger?.warn("gc: failed to delete orphan volume", {
          volumeId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let snapshotsDeleted = 0;
    let snapshotsFailed = 0;
    for (const id of orphanSnapshots) {
      try {
        await this.deps.storage.deleteSnapshot(id);
        snapshotsDeleted += 1;
      } catch (err) {
        snapshotsFailed += 1;
        this.deps.logger?.warn("gc: failed to delete orphan snapshot", {
          snapshotId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { volumesDeleted, snapshotsDeleted, volumesFailed, snapshotsFailed };
  }

  /**
   * Self-heal orphaned workspace tasks: stop any RUNNING task this platform launched
   * that no workspace record references (a record was deleted, never persisted, or
   * repointed). The compute analogue of {@link collectGarbage} — best-effort per task
   * (one stop failure is counted + logged, never aborts the sweep), guarded by the
   * same grace window so a just-launched-but-not-yet-recorded task is spared. No-op
   * when the compute backend can't enumerate tagged tasks (`listWorkspaceTasks` absent).
   */
  async reapOrphanTasks(): Promise<ReapResult> {
    const compute = this.deps.compute;
    const listTasks = compute?.listWorkspaceTasks?.bind(compute);
    if (compute === undefined || listTasks === undefined) {
      return { scanned: 0, reaped: 0, failed: 0 };
    }
    const [referenced, existing] = await Promise.all([
      this.deps.service.listReferencedTasks(),
      listTasks(),
    ]);
    const orphans = selectOrphanTasks(existing, new Set(referenced), this.now(), this.gcGraceMs);

    let reaped = 0;
    let failed = 0;
    for (const task of orphans) {
      try {
        await compute.stopTask(task.id);
        reaped += 1;
      } catch (err) {
        failed += 1;
        this.deps.logger?.warn("reap: failed to stop orphan workspace task", {
          taskId: task.id,
          workspaceId: task.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { scanned: existing.length, reaped, failed };
  }

  /** One full maintenance sweep: scale-to-zero, scheduled snapshots, reap orphaned
   * tasks, then GC. */
  async runMaintenance(): Promise<MaintenanceResult> {
    // Provisioning recovery first: a record stranded mid-wake must be back to
    // stopped before any other sweep reasons about it.
    const provisioning = await this.recoverProvisioning();
    // Drift next: stop() on a record whose task died out-of-band would try
    // to snapshot a volume the platform already released.
    const drift = await this.detectDrift();
    const idle = await this.runOnce();
    const snapshots = await this.snapshotDue();
    // Reap orphaned tasks before GC: stopping an orphan releases its managed volume
    // (deleteOnTermination), which the next sweep's GC then reaps.
    const tasks = await this.reapOrphanTasks();
    const gc = await this.collectGarbage();
    return { provisioning, drift, idle, snapshots, tasks, gc };
  }
}
