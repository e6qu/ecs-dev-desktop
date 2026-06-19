// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import type { WorkspaceDto, WorkspaceInspectionDto } from "@edd/api-contracts";
import {
  assertNever,
  assertTerminable,
  baseImage,
  conflictError,
  deriveWorkspaceTimeline,
  email,
  err,
  isoTimestamp,
  isUnrecoverable,
  markActivity,
  markDeleting,
  markProvisioned,
  markRecovered,
  markSnapshotLost,
  markStopped,
  markTaskLost,
  markWaking,
  METRIC_SECURITY_PRIVILEGE_ATTEMPT,
  METRIC_WORKSPACE_WAKE_LATENCY_MS,
  newWorkspaceId,
  notFoundError,
  ok,
  ownerId,
  planConnect,
  provision,
  recordSnapshot,
  snapshotId,
  taskId,
  transition,
  unavailableError,
  volumeId,
  workspaceId,
  type BaseImage,
  type Clock,
  type ComputeProvider,
  type ComputeTask,
  type DomainError,
  type Email,
  type IsoTimestamp,
  type MetricSink,
  type OwnerId,
  type ReferencedStorage,
  type Result,
  type SnapshotCandidate,
  type SnapshotId,
  type StorageProvider,
  type TaskId,
  type VolumeId,
  type DesiredState,
  type Workspace,
  type WorkspaceId,
  type WorkspaceState,
} from "@edd/core";
import { writeTransaction, type AuditEventEntity, type WorkspaceEntity } from "@edd/db";

import { toWorkspaceDetail, toWorkspaceDto } from "./dto";

/** Actor attributed to transitions with no human principal (reconciler sweeps,
 * gate-wakes without a forwarded identity). */
const SYSTEM_ACTOR = "system";

/** A concurrent waker that lost the claim waits up to this long for the winner's
 * wake to reach running (cold start = RunTask + readiness, tens of seconds),
 * polling at this interval. It blocks for the same window the old
 * launch-then-compensate path did — but without launching a second task. */
const WAKE_WAIT_TIMEOUT_MS = 180_000;
const WAKE_POLL_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The compute backend could not launch a task (e.g. cluster missing, throttled).
 * Thrown by `create()` (which returns a DTO, not a Result) so the route maps it to
 * a 503 — a handled, retryable failure, never an unexpected 500. `start()` returns
 * the equivalent `unavailableError` through its Result instead.
 */
export class ComputeUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputeUnavailableError";
  }
}

/** A lifecycle event to record atomically with its state transition. */
interface LifecycleAudit {
  action: string;
  target: WorkspaceId;
  actor: string;
  detail: string;
}

export interface WorkspaceServiceDeps {
  workspaces: WorkspaceEntity;
  storage: StorageProvider;
  compute: ComputeProvider;
  clock: Clock;
  /**
   * Optional first-class lifecycle audit ledger (the `auditEvent` entity over the
   * same single table). When present, `WorkspaceService` records one event per
   * *actual* state transition (create/start/stop/delete) **in the same DynamoDB
   * transaction as the transition** — so a billable event can never be lost or
   * double-written relative to the transition it records. This makes the ledger
   * the authoritative, exact timeline the cost model prices and the admin feed
   * shows; every caller (routes, reconciler, gate-wake) accrues exactly once.
   */
  audit?: AuditEventEntity;
  /** Optional metric sink (CloudWatch EMF on AWS; no-op otherwise). Used to time
   * wake-on-connect cold starts — a core SLO. Absent → no metrics emitted. */
  metrics?: MetricSink;
}

/** A synthetic version-conflict error so a canceled transaction flows through the
 * SAME conflict handling as a rejected conditional write (see `isVersionConflict`). */
function transactionCanceledAsConflict(): Error {
  const e = new Error("conditional request failed (transaction canceled)");
  e.name = "ConditionalCheckFailedException";
  return e;
}

/** ElectroDB transaction-item codes that are PERMANENT failures — a bad write, not a
 * concurrency loss — so a retry can't fix them and they must surface loudly rather
 * than being misreported as a benign optimistic-CAS conflict (§6.5). The contention
 * codes (`ConditionalCheckFailed`, `TransactionConflict`, throttling) keep the
 * conflict/retry path, which is the right "someone else changed it, retry" semantics. */
const FATAL_TX_CODES: ReadonlySet<string> = new Set([
  "ValidationError",
  "ItemCollectionSizeLimitExceeded",
]);

interface CanceledTransaction {
  readonly data?: readonly ({ readonly code?: string } | null | undefined)[] | null;
}

/** The permanent-failure code among a canceled transaction's items, if any. */
export function fatalTransactionCode(result: CanceledTransaction): string | undefined {
  for (const item of result.data ?? []) {
    const code = item?.code;
    if (code !== undefined && FATAL_TX_CODES.has(code)) return code;
  }
  return undefined;
}

/** Throw the right error for a canceled write transaction: a permanent data error
 * surfaces loudly (a real bug → 500); everything else is the benign optimistic-CAS
 * conflict the caller's version-conflict handling expects. */
function throwForCanceledTransaction(result: CanceledTransaction): never {
  const fatal = fatalTransactionCode(result);
  if (fatal !== undefined) {
    throw new Error(
      `workspace write transaction failed (DynamoDB ${fatal}) — not a concurrency conflict`,
    );
  }
  throw transactionCanceledAsConflict();
}

/** Projection of an active workspace used by the reconciler. */
export interface ActiveWorkspace {
  id: WorkspaceId;
  lastActivity: IsoTimestamp;
}

/** The string-shaped persistence record (the DynamoDB boundary). */
interface WorkspaceRecord {
  id: string;
  ownerId: string;
  ownerEmail?: string;
  repoUrl?: string;
  baseImage: string;
  state: WorkspaceState;
  desiredState?: DesiredState;
  deleteRequestedAt?: string;
  createdAt: string;
  lastActivity: string;
  volumeId?: string;
  taskId?: string;
  latestSnapshotId?: string;
  latestSnapshotAt?: string;
  sshHost?: string;
  version: number;
}

/** A loaded workspace plus the persistence version that read observed — every
 * transition write is conditioned on it (optimistic concurrency). */
interface LoadedWorkspace {
  ws: Workspace;
  version: number;
}

/** True when a write was rejected by its condition expression: a concurrent
 * writer advanced the record since our read (or deleted it). */
function isVersionConflict(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e.name === "ConditionalCheckFailedException") return true;
    if (/conditional request failed/i.test(e.message)) return true;
  }
  return false;
}

/** True when a storage op failed because its target volume/snapshot is gone —
 * EBS `InvalidVolume.NotFound` on real cloud, `ENOENT` from the filesystem fake.
 * During a transition this means a concurrent op tore the resource down (a lost
 * race), as distinct from a genuine storage outage. */
function isResourceGoneError(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const codes = e as { code?: string; Code?: string };
    if (codes.code === "ENOENT" || codes.Code === "ENOENT") return true;
    const haystack = `${e.name} ${codes.code ?? ""} ${codes.Code ?? ""} ${e.message}`;
    if (/not.?found|does not exist|no such file/i.test(haystack)) return true;
  }
  return false;
}

/** Brand a persisted record into a domain object (imperative-shell boundary). */
function toWorkspace(r: WorkspaceRecord): Workspace {
  return {
    id: workspaceId(r.id),
    ownerId: ownerId(r.ownerId),
    ownerEmail: r.ownerEmail === undefined ? undefined : email(r.ownerEmail),
    repoUrl: r.repoUrl,
    baseImage: baseImage(r.baseImage),
    state: r.state,
    desiredState: r.desiredState,
    deleteRequestedAt:
      r.deleteRequestedAt === undefined ? undefined : isoTimestamp(r.deleteRequestedAt),
    createdAt: isoTimestamp(r.createdAt),
    lastActivity: isoTimestamp(r.lastActivity),
    volumeId: r.volumeId === undefined ? undefined : volumeId(r.volumeId),
    taskId: r.taskId === undefined ? undefined : taskId(r.taskId),
    latestSnapshotId: r.latestSnapshotId === undefined ? undefined : snapshotId(r.latestSnapshotId),
    latestSnapshotAt:
      r.latestSnapshotAt === undefined ? undefined : isoTimestamp(r.latestSnapshotAt),
    sshHost: r.sshHost,
  };
}

/**
 * Imperative shell over the functional core: it performs the storage/compute/DB
 * I/O, then calls the pure `@edd/core` functions to compute the next `Workspace`.
 * Persistence is real (ElectroDB); storage/compute go through ports.
 */
export class WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  async create(input: {
    ownerId: OwnerId;
    ownerEmail?: Email;
    baseImage: BaseImage;
    repoUrl?: string;
    repoRef?: string;
  }): Promise<WorkspaceDto> {
    const id = newWorkspaceId();
    const at = isoTimestamp(this.deps.clock.now());
    // ECS creates the managed EBS volume at task launch and returns its id. The
    // repo (if any) is cloned into the session at first boot. A launch failure is a
    // handled, retryable condition (→ 503 at the route), not an unexpected 500.
    let task;
    try {
      task = await this.deps.compute.runTask({
        workspaceId: id,
        baseImage: input.baseImage,
        ...(input.repoUrl === undefined ? {} : { repoUrl: input.repoUrl }),
        ...(input.repoRef === undefined ? {} : { repoRef: input.repoRef }),
      });
    } catch (e) {
      throw new ComputeUnavailableError(`could not launch workspace task: ${asMessage(e)}`);
    }
    const ws = provision({
      id,
      ownerId: input.ownerId,
      ownerEmail: input.ownerEmail,
      repoUrl: input.repoUrl,
      baseImage: input.baseImage,
      volumeId: task.volumeId,
      taskId: task.id,
      at,
      sshHost: task.sshHost,
    });
    try {
      await this.persistNew(ws, {
        action: "session.create",
        target: id,
        actor: input.ownerEmail ?? input.ownerId,
        detail: input.repoUrl === undefined ? "blank session" : `repo ${input.repoUrl}`,
      });
    } catch (err) {
      // Crash-consistency: the task launched but the record never landed —
      // stop the task so nothing real leaks, then surface the original error.
      await this.deps.compute.stopTask(task.id);
      throw err;
    }
    return toWorkspaceDto(ws);
  }

  async list(filter?: { ownerId?: OwnerId }): Promise<WorkspaceDto[]> {
    const owner = filter?.ownerId;
    // `pages: "all"` is mandatory: a single DynamoDB page caps at 1 MB, so a
    // bare `.go()` silently truncates. That undercounts the per-owner list used
    // for quota enforcement (a quota BYPASS at scale) and hides workspaces from
    // the admin all-list. ElectroDB paginates fully only when asked.
    const { data } = owner
      ? await this.deps.workspaces.query.byOwner({ ownerId: owner }).go({ pages: "all" })
      : await this.deps.workspaces.scan.go({ pages: "all" });
    return data.map((r: WorkspaceRecord) => toWorkspaceDto(toWorkspace(r)));
  }

  async get(id: WorkspaceId): Promise<WorkspaceDto | null> {
    const loaded = await this.find(id);
    return loaded === null ? null : toWorkspaceDto(loaded.ws);
  }

  /** Full admin diagnostics: the detailed record + a derived lifecycle timeline. */
  async inspect(id: WorkspaceId): Promise<WorkspaceInspectionDto | null> {
    const loaded = await this.find(id);
    if (loaded === null) return null;
    const { ws } = loaded;
    return {
      workspace: toWorkspaceDetail(ws),
      timeline: deriveWorkspaceTimeline({
        createdAt: ws.createdAt,
        lastActivity: ws.lastActivity,
        ...(ws.latestSnapshotAt === undefined ? {} : { latestSnapshotAt: ws.latestSnapshotAt }),
      }),
    };
  }

  /** Active (running/idle) workspaces with last-activity — the reconciler's input. */
  async listActive(): Promise<ActiveWorkspace[]> {
    const records = await this.recordsByStates(["running", "idle"]);
    return records.map((r) => ({
      id: workspaceId(r.id),
      lastActivity: isoTimestamp(r.lastActivity),
    }));
  }

  /** Workspaces sitting in `provisioning` — candidates for the reconciler's stuck-wake
   * recovery (the pure age filter decides which are actually stuck). `lastActivity` is
   * the claim time `markWaking` stamped at PHASE 1. */
  async listStuckProvisioning(): Promise<ActiveWorkspace[]> {
    const records = await this.recordsByStates(["provisioning"]);
    return records.map((r) => ({
      id: workspaceId(r.id),
      lastActivity: isoTimestamp(r.lastActivity),
    }));
  }

  /** Revert a workspace whose wake crashed mid-flight (stuck `provisioning`) back to
   * `stopped` so it is wake-able again — the self-healing counterpart of the in-process
   * `rollbackWake`. The snapshot is carried forward (a wake always has one) and no
   * task/volume is bound yet, so nothing real is orphaned (a task whose launch outran
   * the crash is reaped by the orphan-task reaper). A lost version-CAS race — a slow
   * wake that finally committed `→running` — is a benign conflict, not an error. No
   * audit event: the claim was never billed, so neither is the revert. */
  async recoverStuckProvisioning(id: WorkspaceId): Promise<Result<void, DomainError>> {
    const loaded = await this.find(id);
    if (loaded?.ws.state !== "provisioning") {
      return err(conflictError(`workspace ${id} is no longer provisioning`));
    }
    const reverted = markStopped(loaded.ws, undefined, isoTimestamp(this.deps.clock.now()));
    if (!reverted.ok) return err(reverted.error);
    try {
      await this.persistTransition(reverted.value, loaded.version);
      return ok(undefined);
    } catch (e) {
      if (isVersionConflict(e)) {
        return err(conflictError(`workspace ${id} provisioning recovery lost a race`));
      }
      throw e;
    }
  }

  /** Workspaces with a live volume that the reconciler may snapshot on schedule. */
  async listSnapshotCandidates(): Promise<SnapshotCandidate[]> {
    const records = await this.recordsByStates(["running", "idle"]);
    return records
      .filter((r) => r.volumeId !== undefined)
      .map((r) => ({
        id: workspaceId(r.id),
        createdAt: isoTimestamp(r.createdAt),
        ...(r.latestSnapshotAt === undefined
          ? {}
          : { latestSnapshotAt: isoTimestamp(r.latestSnapshotAt) }),
      }));
  }

  /** Every volume/snapshot id still referenced by a workspace — GC's keep-set. */
  async listReferencedStorage(): Promise<ReferencedStorage> {
    const { data } = await this.deps.workspaces.scan.go({ pages: "all" });
    const volumeIds: VolumeId[] = [];
    const snapshotIds: SnapshotId[] = [];
    data.forEach((r: WorkspaceRecord) => {
      if (r.volumeId !== undefined) volumeIds.push(volumeId(r.volumeId));
      if (r.latestSnapshotId !== undefined) snapshotIds.push(snapshotId(r.latestSnapshotId));
    });
    return { volumeIds, snapshotIds };
  }

  /** Every task id any workspace record still references — the orphan-task reaper's
   * keep-set. Conservative: includes a stopped record's last task id (that task is
   * not RUNNING, so it is not a reap candidate anyway), so a task any record names is
   * never reaped. A RUNNING workspace task in no record is the orphan. */
  async listReferencedTasks(): Promise<readonly TaskId[]> {
    const { data } = await this.deps.workspaces.scan.go({ pages: "all" });
    const taskIds: TaskId[] = [];
    data.forEach((r: WorkspaceRecord) => {
      if (r.taskId !== undefined) taskIds.push(taskId(r.taskId));
    });
    return taskIds;
  }

  /** Ids of every workspace that still exists (any state) — the orphan-secret
   * reaper's keep-set. Fully paginated, like the other reconciler reads. */
  async listWorkspaceIds(): Promise<readonly WorkspaceId[]> {
    const { data } = await this.deps.workspaces.scan.go({ pages: "all" });
    return data.map((r: WorkspaceRecord) => workspaceId(r.id));
  }

  /** Fetch all workspace records in the given lifecycle states (fully paginated). */
  private async recordsByStates(states: readonly WorkspaceState[]): Promise<WorkspaceRecord[]> {
    const pages = await Promise.all(
      states.map((state) => this.deps.workspaces.query.byState({ state }).go({ pages: "all" })),
    );
    return pages.flatMap((page) => page.data.map((r: WorkspaceRecord) => r));
  }

  /** Snapshot a volume as part of a transition, conditioned on `version`. A
   * concurrent transition can delete the volume mid-snapshot (e.g. another stop
   * releasing it), which surfaces as a storage error (EBS `InvalidVolume.NotFound`;
   * the fake's ENOENT). If the record has since advanced, that error IS the lost
   * race — report a conflict instead of throwing a 500; otherwise it is a genuine
   * storage failure and rethrows. */
  private async snapshotForTransition(
    id: WorkspaceId,
    volumeId: VolumeId,
    version: number,
  ): Promise<Result<SnapshotId, DomainError>> {
    try {
      const snap = await this.deps.storage.createSnapshot(volumeId);
      return ok(snap.id);
    } catch (e) {
      // The volume vanished (concurrent teardown) OR the record already advanced
      // since our read — either way this transition lost the race. Anything else
      // is a genuine storage failure and propagates.
      const current = await this.find(id);
      if (isResourceGoneError(e) || current?.version !== version) {
        return err(conflictError(`snapshot of ${id} lost a concurrent update`));
      }
      throw e;
    }
  }

  /** Scale to zero: snapshot the managed volume, then stop the task (which
   * releases the volume). Snapshot first — stopping the task tears the volume down. */
  async stop(
    id: WorkspaceId,
    actor: string = SYSTEM_ACTOR,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    const validated = transition(ws.state, "stop"); // validate-first, before any I/O
    if (!validated.ok) return validated;
    const at = isoTimestamp(this.deps.clock.now());
    let freshSnapshot: { id: SnapshotId; at: IsoTimestamp } | undefined;
    if (ws.volumeId !== undefined) {
      const snap = await this.snapshotForTransition(id, ws.volumeId, version);
      if (!snap.ok) return snap;
      freshSnapshot = { id: snap.value, at };
    }
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    const next = markStopped(ws, freshSnapshot, at);
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version, {
        action: "session.stop",
        target: id,
        actor,
        detail: "scaled to zero",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      // A concurrent writer advanced the record. If it also reached "stopped"
      // the outcome stands (idempotent); anything else is a real conflict.
      // The stopTask/snapshot already performed are safe: stopping a stopped
      // task is a no-op, and an unreferenced snapshot is reaped by GC.
      const current = await this.find(id);
      if (current === null) return err(notFoundError("workspace", id));
      if (current.ws.state === "stopped") return ok(toWorkspaceDto(current.ws));
      return err(conflictError(`stop of ${id} lost a concurrent update (now ${current.ws.state})`));
    }
    return ok(toWorkspaceDto(next.value));
  }

  /**
   * Wake from a snapshot, **claim-before-launch**: persist the
   * `stopped → provisioning` claim with the optimistic-version CAS FIRST, and only
   * the winner launches a task. Concurrent wakers (a burst of connects) lose the
   * claim and wait for the winner to reach running — so exactly one RunTask is ever
   * issued, instead of N tasks launched-then-compensated (a thundering herd that
   * also intermittently overran the sim). On launch failure the claim is rolled
   * back to stopped so the workspace stays wake-able.
   */
  async start(
    id: WorkspaceId,
    actor: string = SYSTEM_ACTOR,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    // Strict wake transition (stopped → provisioning): any non-stopped state is a
    // conflict here. The idempotent "already running / already waking" handling
    // for concurrent callers lives in connect(), which re-dispatches on conflict.
    const claim = markWaking(ws, isoTimestamp(this.deps.clock.now()));
    if (!claim.ok) return claim;
    if (ws.latestSnapshotId === undefined) {
      return err(conflictError(`cannot start ${id}: no snapshot to hydrate from`));
    }

    // PHASE 1 — claim the wake (stopped → provisioning), version-conditioned. No
    // task launched yet, so a failure here can never leak one.
    try {
      await this.persistTransition(claim.value, version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      // Another waker won the claim (or a stop/delete raced) — wait for the
      // winner's wake to finish rather than launching a second task.
      return this.awaitWoken(id);
    }

    // PHASE 2 — we are the sole launcher: run the task, then commit
    // provisioning → running.
    const at = isoTimestamp(this.deps.clock.now());
    let task: ComputeTask;
    try {
      task = await this.deps.compute.runTask({
        workspaceId: ws.id,
        baseImage: ws.baseImage,
        fromSnapshot: ws.latestSnapshotId,
      });
    } catch (e) {
      // Launch failed; roll the claim back to stopped (snapshot untouched) so the
      // workspace stays wake-able, then surface a handled 503 (not an uncaught 500).
      await this.rollbackWake(id);
      return err(unavailableError(`could not launch workspace task: ${asMessage(e)}`));
    }

    const claimed = await this.find(id);
    if (claimed === null) {
      // Deleted out from under us mid-launch — stop the orphan, report gone.
      await this.deps.compute.stopTask(task.id);
      return err(notFoundError("workspace", id));
    }
    const next = markProvisioned(claimed.ws, task.volumeId, task.id, at, task.sshHost);
    if (!next.ok) {
      await this.deps.compute.stopTask(task.id);
      return next;
    }
    try {
      await this.persistTransition(next.value, claimed.version, {
        action: "session.start",
        target: id,
        actor,
        detail: "woken from snapshot",
      });
    } catch (e) {
      // A concurrent stop/delete changed the record while we launched. Stop our
      // task so it cannot leak; roll the provisioning claim back if it survived.
      await this.deps.compute.stopTask(task.id);
      if (!isVersionConflict(e)) {
        await this.rollbackWake(id);
        throw e;
      }
      const current = await this.find(id);
      if (current === null) return err(notFoundError("workspace", id));
      const { state } = current.ws;
      if (state === "running" || state === "idle") return ok(toWorkspaceDto(current.ws));
      return err(conflictError(`wake of ${id} lost a concurrent update (now ${state})`));
    }
    // Wake cold-start latency (claim → RunTask → routable + committed) — a core SLO.
    this.deps.metrics?.timing(
      METRIC_WORKSPACE_WAKE_LATENCY_MS,
      Date.parse(this.deps.clock.now()) - Date.parse(at),
      { baseImage: ws.baseImage },
    );
    return ok(toWorkspaceDto(next.value));
  }

  /** Wait for an in-flight wake (claimed by another caller) to reach running/idle,
   * so a concurrent connect still returns a ready workspace without launching its
   * own task. Returns the winner's state, or a conflict if the wake failed/timed out. */
  private async awaitWoken(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const deadline = Date.now() + WAKE_WAIT_TIMEOUT_MS;
    for (;;) {
      const loaded = await this.find(id);
      if (loaded === null) return err(notFoundError("workspace", id));
      const { state } = loaded.ws;
      if (state === "running" || state === "idle") return ok(toWorkspaceDto(loaded.ws));
      if (state !== "provisioning") {
        // The winner's wake did not complete (rolled back / failed / deleted).
        return err(conflictError(`wake of ${id} did not complete (now ${state})`));
      }
      if (Date.now() >= deadline) {
        return err(conflictError(`timed out waiting for ${id} to wake`));
      }
      await sleep(WAKE_POLL_INTERVAL_MS);
    }
  }

  /** Best-effort: revert a provisioning claim back to stopped after a failed
   * launch, so the workspace is wake-able again (the snapshot is untouched). A lost
   * race here is benign — whoever advanced the record owns it now. */
  private async rollbackWake(id: WorkspaceId): Promise<void> {
    const loaded = await this.find(id);
    if (loaded?.ws.state !== "provisioning") return;
    const reverted = markStopped(loaded.ws, undefined, isoTimestamp(this.deps.clock.now()));
    if (!reverted.ok) return;
    try {
      await this.persistTransition(reverted.value, loaded.version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
    }
  }

  /** Wake-on-connect: ensure the workspace is reachable for an incoming connection
   * (e.g. SSH via the gateway). Idempotent — a running/idle workspace is returned
   * as-is, a scaled-to-zero one is woken from its snapshot, an in-flight wake is
   * waited on until it reaches running (so the caller always gets a ready
   * workspace, not a half-woken one to poll), and a terminal one is rejected. */
  async connect(
    id: WorkspaceId,
    actor: string = SYSTEM_ACTOR,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws } = found.value;
    const action = planConnect(ws.state);
    switch (action) {
      case "ready":
        return ok(toWorkspaceDto(ws));
      case "pending":
        // A wake is already in flight (another connect claimed it) — wait for it to
        // reach running rather than handing back a provisioning workspace.
        return this.awaitWoken(id);
      case "wake": {
        // Claim + launch the wake. start() is strict, so if the state advanced
        // between our read and start's (another caller woke it concurrently),
        // re-evaluate and converge: running/idle → ready, provisioning → wait.
        const started = await this.start(id, actor);
        if (started.ok) return started;
        const reloaded = await this.find(id);
        if (reloaded === null) return started;
        if (reloaded.ws.state === "running" || reloaded.ws.state === "idle") {
          return ok(toWorkspaceDto(reloaded.ws));
        }
        if (reloaded.ws.state === "provisioning") return this.awaitWoken(id);
        return started;
      }
      case "unavailable":
        return err(conflictError(`cannot connect to ${id}: workspace is ${ws.state}`));
      default:
        return assertNever(action);
    }
  }

  /** Idle-agent heartbeat: record activity so the reconciler doesn't scale the
   * workspace to zero (and wake it from idle). Heartbeats are frequent and
   * harmless, so a lost write race retries once before reporting conflict. */
  async heartbeat(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    for (let attempt = 0; ; attempt++) {
      const found = await this.require(id);
      if (!found.ok) return found;
      const next = markActivity(found.value.ws, isoTimestamp(this.deps.clock.now()));
      if (!next.ok) return next;
      try {
        await this.persistTransition(next.value, found.value.version);
      } catch (e) {
        if (isVersionConflict(e) && attempt === 0) continue;
        if (isVersionConflict(e))
          return err(conflictError(`heartbeat for ${id} lost concurrent updates`));
        throw e;
      }
      return ok(toWorkspaceDto(next.value));
    }
  }

  /** Point-in-time snapshot of a running workspace. */
  async snapshot(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    if (ws.volumeId === undefined) {
      return err(conflictError(`cannot snapshot ${id}: no active volume`));
    }
    const snap = await this.snapshotForTransition(id, ws.volumeId, version);
    if (!snap.ok) return snap;
    const next = recordSnapshot(ws, snap.value, isoTimestamp(this.deps.clock.now()));
    try {
      await this.persistTransition(next, version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      // The snapshot itself exists either way; an unreferenced one is GC'd.
      return err(conflictError(`snapshot of ${id} lost a concurrent update`));
    }
    return ok(toWorkspaceDto(next));
  }

  /**
   * Drift detection (reconciler): if the record claims an active task that the
   * compute platform says is gone (crash, eviction, out-of-band stop), stop
   * advertising live bindings — `stopped` when a snapshot can restore it,
   * `error` when nothing can. Returns `lost: false` when the task is healthy.
   */
  async reconcileTaskLoss(
    id: WorkspaceId,
  ): Promise<Result<{ lost: boolean; workspace: WorkspaceDto }, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    if (ws.taskId === undefined || (ws.state !== "running" && ws.state !== "idle")) {
      return ok({ lost: false, workspace: toWorkspaceDto(ws) });
    }
    if ((await this.deps.compute.taskState(ws.taskId)) === "running") {
      return ok({ lost: false, workspace: toWorkspaceDto(ws) });
    }
    const next = markTaskLost(ws, isoTimestamp(this.deps.clock.now()));
    if (!next.ok) return next;
    try {
      // The task was lost out-of-band; the record left a running interval open.
      // Record a stop atomically so the cost ledger closes it (attributed to the
      // drift sweep).
      await this.persistTransition(next.value, version, {
        action: "session.stop",
        target: id,
        actor: "system:drift",
        detail: `task lost; reconciled to ${next.value.state}`,
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      // A concurrent writer (user action) advanced the record — defer to it;
      // the next sweep re-evaluates from the fresh state.
      return err(conflictError(`drift reconcile of ${id} lost a concurrent update`));
    }
    return ok({ lost: true, workspace: toWorkspaceDto(next.value) });
  }

  /** Permanently delete the workspace and its runtime resources. */
  async remove(id: WorkspaceId, actor: string = SYSTEM_ACTOR): Promise<Result<void, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    if (ws.state === "deleting") return ok(undefined); // idempotent: already tombstoned
    const terminable = assertTerminable(ws);
    if (!terminable.ok) return terminable;
    // Durable-intent delete: move to the `deleting` tombstone (desiredState="deleted")
    // instead of hard-deleting the row. The record persists so the reconciler can
    // converge teardown of the task/volume/snapshot/secret/task-def and only then
    // remove it — making an interrupted delete resumable. Version-conditioned like
    // every transition (a delete racing a wake can't strand a just-launched task), and
    // the session.delete audit event is written in the same transaction so the cost
    // ledger keeps the workspace's final cost.
    const next = markDeleting(ws, isoTimestamp(this.deps.clock.now()));
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version, {
        action: "session.delete",
        target: id,
        actor,
        detail: "delete requested",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`delete of ${id} lost a concurrent update`));
    }
    return ok(undefined);
  }

  /** Workspaces in the `deleting` tombstone — the reconciler's finish-delete keep-set. */
  async listDeleting(): Promise<readonly Workspace[]> {
    return (await this.recordsByStates(["deleting"])).map(toWorkspace);
  }

  /** `error` workspaces that still have a snapshot to restore from — the reconciler's
   * recover keep-set (the rest are unrecoverable and only deletable). */
  async listRecoverableErrors(): Promise<readonly Workspace[]> {
    return (await this.recordsByStates(["error"]))
      .map(toWorkspace)
      .filter((ws) => !isUnrecoverable(ws));
  }

  /**
   * Finish tearing down a `deleting` workspace, then remove its record. Convergent +
   * idempotent (safe to re-run): per the Middle data-safety policy, if it still has a
   * live volume and no recent snapshot it takes a FINAL snapshot first (so a delete of
   * a working session doesn't lose data) — a snapshot failure leaves the tombstone for
   * a retry rather than destroying data. Then it stops the task (releasing the managed
   * volume) and hard-removes the record; the now-orphan snapshot/secret/task-def are
   * reaped by the existing GC sweeps after their grace (the retention window).
   */
  async finishDeleting(id: WorkspaceId): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return ok(undefined); // already gone — converged
    const { ws, version } = found;
    if (ws.state !== "deleting") return ok(undefined); // no longer deleting
    // Capture a final snapshot of a live volume before tearing it down (data-safety).
    if (ws.volumeId !== undefined && this.snapshotStale(ws)) {
      try {
        await this.deps.storage.createSnapshot(ws.volumeId);
      } catch (e) {
        // Don't destroy data on a transient snapshot failure: leave the tombstone for
        // the next sweep (surfaced via the reconciler's failure metric/alarm).
        return err(conflictError(`final snapshot for ${id} failed: ${asMessage(e)}`));
      }
    }
    if (ws.taskId !== undefined) {
      // Best-effort: the orphan-task reaper is the backstop if this stop fails.
      try {
        await this.deps.compute.stopTask(ws.taskId);
      } catch {
        /* reaper backstop */
      }
    }
    try {
      await this.deps.workspaces
        .delete({ id })
        .where(({ version: v }, { eq }) => eq(v, version))
        .go();
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`finishDeleting ${id} lost a concurrent update`));
    }
    return ok(undefined);
  }

  /** Self-recovery: move a recoverable `error` workspace back to `stopped` (wake-able)
   * — it has a snapshot, so a later connect() hydrates a fresh volume from it. */
  async recoverError(id: WorkspaceId): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const { ws, version } = found;
    const recovered = markRecovered(ws, isoTimestamp(this.deps.clock.now()));
    if (!recovered.ok) return recovered;
    try {
      await this.persistTransition(recovered.value, version, {
        action: "session.recover",
        target: id,
        actor: SYSTEM_ACTOR,
        detail: "recovered from error to stopped",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`recover of ${id} lost a concurrent update`));
    }
    return ok(undefined);
  }

  /** Whether a workspace lacks a recent snapshot (none, or older than the snapshot
   * interval) — used to decide a final snapshot before delete. */
  private snapshotStale(ws: Workspace): boolean {
    return ws.latestSnapshotId === undefined;
  }

  /**
   * Record a security event reported by the in-workspace privilege guard (a blocked
   * attempt to run a privileged tool like docker/sudo). Writes a first-class audit
   * event (so it shows in the admin audit/Logs view) and emits a metric dimensioned by
   * tool (so it shows in the admin dashboard + the security alarm). The sandbox already
   * blocked the operation; this makes it visible + auditable, fleet-wide.
   */
  async recordSecurityEvent(
    id: WorkspaceId,
    event: { kind: "privilege_attempt"; tool: string },
  ): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const item = this.auditItem({
      action: `security.${event.kind}`,
      target: id,
      actor: "workspace",
      detail: event.tool,
    });
    if (item !== undefined) await item.entity.put(item.attrs).go();
    this.deps.metrics?.count(METRIC_SECURITY_PRIVILEGE_ATTEMPT, 1, { tool: event.tool });
    return ok(undefined);
  }

  /** Stopped/error workspaces that reference a snapshot they would restore from — the
   * reverse-drift keep-set (a referenced snapshot missing from storage was deleted
   * out-of-band, leaving the workspace un-wakeable). */
  async listSnapshotReferences(): Promise<readonly { id: WorkspaceId; snapshotId: SnapshotId }[]> {
    const records = await this.recordsByStates(["stopped", "error"]);
    const refs: { id: WorkspaceId; snapshotId: SnapshotId }[] = [];
    for (const r of records) {
      if (r.latestSnapshotId !== undefined) {
        refs.push({ id: workspaceId(r.id), snapshotId: snapshotId(r.latestSnapshotId) });
      }
    }
    return refs;
  }

  /** Reverse drift: the snapshot a stopped/error workspace would restore from has been
   * deleted out-of-band, so mark it `error` with the dangling reference cleared
   * (honestly unrecoverable + deletable, not a record that silently fails every wake). */
  async markSnapshotLostFor(id: WorkspaceId): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return ok(undefined);
    const { ws, version } = found;
    const lost = markSnapshotLost(ws, isoTimestamp(this.deps.clock.now()));
    if (!lost.ok) return ok(undefined); // changed since listed (e.g. woken) — skip, not an error
    try {
      await this.persistTransition(lost.value, version, {
        action: "session.snapshot_lost",
        target: id,
        actor: SYSTEM_ACTOR,
        detail: "referenced snapshot missing; marked unrecoverable",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return ok(undefined); // benign race
    }
    return ok(undefined);
  }

  private async find(id: WorkspaceId): Promise<LoadedWorkspace | null> {
    const { data } = await this.deps.workspaces.get({ id }).go();
    return data === null ? null : { ws: toWorkspace(data), version: data.version };
  }

  private async require(id: WorkspaceId): Promise<Result<LoadedWorkspace, DomainError>> {
    const loaded = await this.find(id);
    return loaded === null ? err(notFoundError("workspace", id)) : ok(loaded);
  }

  /** The audit-event entity + the item to write atomically with a transition, or
   * undefined when no audit ledger is configured (writes take the plain path). */
  private auditItem(a: LifecycleAudit):
    | {
        entity: AuditEventEntity;
        attrs: {
          id: string;
          at: string;
          actor: string;
          action: string;
          target: string;
          detail: string;
        };
      }
    | undefined {
    const entity = this.deps.audit;
    if (entity === undefined) return undefined;
    return {
      entity,
      attrs: {
        id: `evt-${randomUUID()}`,
        at: this.deps.clock.now(),
        actor: a.actor,
        action: a.action,
        target: a.target,
        detail: a.detail,
      },
    };
  }

  /** Insert a brand-new workspace record (fails if the id already exists),
   * recording its `session.create` event in the same transaction. */
  private async persistNew(ws: Workspace, audit: LifecycleAudit): Promise<void> {
    const item = { ...toWorkspaceDetail(ws), version: 0 };
    const auditItem = this.auditItem(audit);
    if (auditItem === undefined) {
      await this.deps.workspaces.create(item).go();
      return;
    }
    const result = await writeTransaction(
      { ws: this.deps.workspaces, ev: auditItem.entity },
      ({ ws: wsE, ev }) => [wsE.create(item).commit(), ev.put(auditItem.attrs).commit()],
    ).go();
    if (result.canceled) throwForCanceledTransaction(result);
  }

  /** Persist a lifecycle transition, conditioned on the version the caller's
   * read observed: a concurrent writer makes this throw a version conflict
   * instead of silently overwriting (and possibly leaking a real task).
   * Cleared optional bindings (volume/task on stop) are removed explicitly —
   * an update, unlike PutItem, keeps attributes it isn't told about. When an
   * `audit` event is given, it is written in the SAME transaction as the patch,
   * so a billable event can never be lost relative to its transition. */
  private async persistTransition(
    ws: Workspace,
    observedVersion: number,
    audit?: LifecycleAudit,
  ): Promise<void> {
    const detail = toWorkspaceDetail(ws);
    const clearable = [
      "volumeId",
      "taskId",
      "latestSnapshotId",
      "latestSnapshotAt",
      "sshHost",
    ] as const;
    const cleared = clearable.filter((field) => detail[field] === undefined);
    const { id, ...fields } = detail;
    const next = { ...fields, version: observedVersion + 1 };

    const auditItem = audit === undefined ? undefined : this.auditItem(audit);
    if (auditItem === undefined) {
      const m = this.deps.workspaces.patch({ id }).set(next);
      const op = cleared.length > 0 ? m.remove([...cleared]) : m;
      await op.where(({ version }, { eq }) => eq(version, observedVersion)).go();
      return;
    }
    const result = await writeTransaction(
      { ws: this.deps.workspaces, ev: auditItem.entity },
      ({ ws: wsE, ev }) => {
        const m = wsE.patch({ id }).set(next);
        const op = cleared.length > 0 ? m.remove([...cleared]) : m;
        return [
          op.where(({ version }, { eq }) => eq(version, observedVersion)).commit(),
          ev.put(auditItem.attrs).commit(),
        ];
      },
    ).go();
    if (result.canceled) throwForCanceledTransaction(result);
  }
}
