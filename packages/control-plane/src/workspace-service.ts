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
  markProvisioningFailed,
  reserve,
  retryProvisioning,
  markRecovered,
  markSnapshotLost,
  markStopped,
  markStopping,
  cancelStopping,
  markTaskLost,
  markTerminated,
  setShare,
  DEFAULT_UNDELETE_RETENTION_MS,
  DEFAULT_STOP_GRACE_MS,
  undeleteWorkspace,
  recordFunctional,
  markWaking,
  METRIC_SECURITY_PRIVILEGE_ATTEMPT,
  METRIC_WORKSPACE_WAKE_LATENCY_MS,
  newWorkspaceId,
  notFoundError,
  ok,
  ownerId,
  planConnect,
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
  type EditorKind,
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
  type FunctionalStatus,
  type Workspace,
  type WorkspaceId,
  type WorkspaceOwnerRole,
  type WorkspaceState,
} from "@edd/core";
import {
  writeTransaction,
  type AuditEventEntity,
  type OwnerWorkspaceCountEntity,
  type WorkspaceEntity,
} from "@edd/db";

import { toWorkspaceDetail, toWorkspaceDto } from "./dto";
import { isVersionConflict } from "./version-conflict";

/** Actor attributed to transitions with no human principal (reconciler sweeps,
 * gate-wakes without a forwarded identity). */
const SYSTEM_ACTOR = "system";

/** A concurrent waker that lost the claim waits up to this long for the winner's
 * wake to reach running (cold start = RunTask + readiness, tens of seconds),
 * polling at this interval. It blocks for the same window the old
 * launch-then-compensate path did — but without launching a second task. */
const WAKE_WAIT_TIMEOUT_MS = 180_000;
const WAKE_POLL_INTERVAL_MS = 250;

/** Idempotency window for security events: the in-workspace guard retries a blocked
 * attempt within seconds, so bucketing the deterministic event id to this window
 * dedupes those retries while still recording genuinely-distinct later attempts. */
const SECURITY_EVENT_BUCKET_MS = 60_000;

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

/** Thrown when a create is refused because the owner is at their per-user workspace
 * quota — detected ATOMICALLY (the create transaction's conditional counter increment
 * canceled), so concurrent creates can't race past the cap. The route maps it to 409. */
export class QuotaExceededError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "QuotaExceededError";
  }
}

/**
 * The fixed audit-action vocabulary. Typed as a union (not a bare string) so a typo'd
 * action is a compile error — the cost ledger filters by exact action string
 * (`=== "session.create"`, the `session.` prefix), so a wrong value would silently
 * mis-attribute billing / drop a session from the report.
 */
type AuditAction =
  | "session.create"
  | "session.start"
  | "session.stop"
  | "session.delete"
  | "session.terminated"
  | "session.recover"
  | "session.undelete"
  | "session.purged"
  | "session.access"
  | "session.share_enabled"
  | "session.share_disabled"
  | "session.snapshot_lost"
  | "security.privilege_attempt";

/** A lifecycle event to record atomically with its state transition. */
interface LifecycleAudit {
  action: AuditAction;
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
  /**
   * Optional per-owner workspace-count entity. When present (and `create` is given a
   * `quotaLimit`), the per-user quota is enforced ATOMICALLY: the create transaction
   * conditionally increments this owner's count, and `finishDeleting` decrements it,
   * so concurrent creates can't race past the cap. Absent → no atomic enforcement
   * (the route's read-check still applies, but the race is not closed).
   */
  ownerCounts?: OwnerWorkspaceCountEntity;
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

/** Like {@link throwForCanceledTransaction}, but for the quota-enforcing create: if the
 * counter op at `quotaIndex` is the one whose condition failed, the owner is at their
 * cap → {@link QuotaExceededError}; otherwise defer to the normal handling. */
function throwForCanceledCreate(
  result: CanceledTransaction,
  quotaIndex: number,
  ownerId: string,
  limit: number,
): never {
  const fatal = fatalTransactionCode(result);
  if (fatal !== undefined) {
    throw new Error(
      `workspace write transaction failed (DynamoDB ${fatal}) — not a concurrency conflict`,
    );
  }
  if ((result.data ?? [])[quotaIndex]?.code === "ConditionalCheckFailed") {
    throw new QuotaExceededError(
      `workspace quota reached for ${ownerId} (limit ${limit.toString()})`,
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
  ownerRole?: WorkspaceOwnerRole;
  repoUrl?: string;
  baseImage: string;
  editor?: EditorKind;
  state: WorkspaceState;
  desiredState?: DesiredState;
  deleteRequestedAt?: string;
  stopRequestedAt?: string;
  stopRequestedBy?: string;
  createdAt: string;
  lastActivity: string;
  volumeId?: string;
  taskId?: string;
  latestSnapshotId?: string;
  latestSnapshotAt?: string;
  sshHost?: string;
  functional?: FunctionalStatus;
  functionalDetail?: string;
  functionalAt?: string;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  terminatedAt?: string;
  shareEnabled?: boolean;
  shareEnabledAt?: string;
  version: number;
}

/** A loaded workspace plus the persistence version that read observed — every
 * transition write is conditioned on it (optimistic concurrency). */
interface LoadedWorkspace {
  ws: Workspace;
  version: number;
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
    ownerRole: r.ownerRole,
    repoUrl: r.repoUrl,
    baseImage: baseImage(r.baseImage),
    editor: r.editor,
    state: r.state,
    desiredState: r.desiredState,
    deleteRequestedAt:
      r.deleteRequestedAt === undefined ? undefined : isoTimestamp(r.deleteRequestedAt),
    stopRequestedAt: r.stopRequestedAt === undefined ? undefined : isoTimestamp(r.stopRequestedAt),
    stopRequestedBy: r.stopRequestedBy,
    createdAt: isoTimestamp(r.createdAt),
    lastActivity: isoTimestamp(r.lastActivity),
    volumeId: r.volumeId === undefined ? undefined : volumeId(r.volumeId),
    taskId: r.taskId === undefined ? undefined : taskId(r.taskId),
    latestSnapshotId: r.latestSnapshotId === undefined ? undefined : snapshotId(r.latestSnapshotId),
    latestSnapshotAt:
      r.latestSnapshotAt === undefined ? undefined : isoTimestamp(r.latestSnapshotAt),
    sshHost: r.sshHost,
    functional: r.functional,
    functionalDetail: r.functionalDetail,
    functionalAt: r.functionalAt === undefined ? undefined : isoTimestamp(r.functionalAt),
    diskUsedBytes: r.diskUsedBytes,
    diskTotalBytes: r.diskTotalBytes,
    terminatedAt: r.terminatedAt === undefined ? undefined : isoTimestamp(r.terminatedAt),
    shareEnabled: r.shareEnabled,
    shareEnabledAt: r.shareEnabledAt === undefined ? undefined : isoTimestamp(r.shareEnabledAt),
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
    /** The owner's role at create time — persisted so the admin quota view can flag the workspace
     * against its owner's per-role limit. */
    ownerRole?: WorkspaceOwnerRole;
    baseImage: BaseImage;
    /** The editor this workspace serves — resolved from the base-image catalog entry by the
     * route; defaults to OpenVSCode. Flows to the container as `EDD_EDITOR_MODE`. */
    editor?: EditorKind;
    repoUrl?: string;
    repoRef?: string;
    /** The owner's per-role workspace cap. When given (and `ownerCounts` is wired),
     * the cap is enforced atomically in the persist transaction — a concurrent create
     * past the cap cancels and throws {@link QuotaExceededError}. */
    quotaLimit?: number;
  }): Promise<WorkspaceDto> {
    // Blocking composition kept for callers that need the launched workspace
    // (tests, scripted flows). The web route uses reserveWorkspace +
    // launchReserved instead, so the browser gets the URL instantly.
    const dto = await this.reserveWorkspace(input);
    const launched = await this.launchReserved(workspaceId(dto.id), {
      ...(input.repoRef === undefined ? {} : { repoRef: input.repoRef }),
    });
    if (!launched.ok) {
      throw new ComputeUnavailableError(
        launched.error.kind === "conflict" ? launched.error.reason : "launch failed",
      );
    }
    return launched.value;
  }

  /**
   * Instant create, phase 1: persist the record (id pre-generated, state
   * `provisioning`, quota enforced atomically) and return it — the browser can
   * navigate to the workspace URL immediately, before any compute exists. The
   * caller then fires {@link launchReserved} (detached in the web route).
   */
  async reserveWorkspace(input: {
    ownerId: OwnerId;
    ownerEmail?: Email;
    ownerRole?: WorkspaceOwnerRole;
    baseImage: BaseImage;
    editor?: EditorKind;
    repoUrl?: string;
    quotaLimit?: number;
  }): Promise<WorkspaceDto> {
    const id = newWorkspaceId();
    const at = isoTimestamp(this.deps.clock.now());
    const ws = reserve({
      id,
      ownerId: input.ownerId,
      ownerEmail: input.ownerEmail,
      ownerRole: input.ownerRole,
      repoUrl: input.repoUrl,
      baseImage: input.baseImage,
      ...(input.editor === undefined ? {} : { editor: input.editor }),
      at,
    });
    await this.persistNew(
      ws,
      {
        action: "session.create",
        target: id,
        actor: input.ownerEmail ?? input.ownerId,
        detail: input.repoUrl === undefined ? "blank session" : `repo ${input.repoUrl}`,
      },
      input.quotaLimit,
    );
    return toWorkspaceDto(ws);
  }

  /**
   * Instant create, phase 2: launch compute for a reserved (`provisioning`,
   * unbound) record and bind it (→ running). NEVER throws — a failure is
   * recorded on the record as `error` + reason (the status page renders it with
   * Retry/Delete) and returned as a Result, so the detached web-route call
   * cannot become an unhandled rejection. Crash mid-launch is covered by the
   * reconciler's provisioning-timeout recovery; a record deleted while the
   * launch was in flight gets its freshly-launched task stopped (crash
   * consistency, reaper backstop).
   */
  async launchReserved(
    id: WorkspaceId,
    opts?: { repoRef?: string },
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const { ws, version } = found;
    if (ws.state !== "provisioning" || ws.taskId !== undefined) {
      // Already launched / already converged elsewhere — idempotent success.
      return ok(toWorkspaceDto(ws));
    }
    let task: ComputeTask;
    try {
      task = await this.deps.compute.runTask({
        workspaceId: id,
        baseImage: ws.baseImage,
        ...(ws.editor === undefined ? {} : { editor: ws.editor }),
        ...(ws.repoUrl === undefined ? {} : { repoUrl: ws.repoUrl }),
        ...(opts?.repoRef === undefined ? {} : { repoRef: opts.repoRef }),
      });
    } catch (e) {
      return this.recordLaunchFailure(id, `could not launch workspace task: ${asMessage(e)}`);
    }
    const at = isoTimestamp(this.deps.clock.now());
    const bound = markProvisioned(ws, task.volumeId, task.id, at, task.sshHost);
    if (!bound.ok) return bound;
    try {
      await this.persistTransition(bound.value, version);
    } catch (e) {
      // The record moved while we launched (most likely a delete): stop the
      // fresh task so nothing real leaks; the reaper is the backstop.
      try {
        await this.deps.compute.stopTask(task.id);
      } catch {
        /* reaper backstop reaps the leaked task by its workspace tag */
      }
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`launch of ${id} lost a concurrent update`));
    }
    return ok(toWorkspaceDto(bound.value));
  }

  /** Record a failed launch on the reserved record: → `error` + reason. */
  private async recordLaunchFailure(
    id: WorkspaceId,
    reason: string,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const failed = markProvisioningFailed(found.ws, reason, isoTimestamp(this.deps.clock.now()));
    if (!failed.ok) return failed;
    try {
      await this.persistTransition(failed.value, found.version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
    }
    return err(unavailableError(reason));
  }

  /**
   * User-initiated retry of a failed launch (the status page's Retry button).
   * A snapshot-less error (failed create) relaunches fresh; an error that still
   * has a snapshot recovers to `stopped` and starts — its data must not be
   * discarded by a fresh volume.
   */
  async retry(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const { ws, version } = found;
    if (ws.latestSnapshotId !== undefined) {
      const recovered = await this.recoverError(id);
      if (!recovered.ok) return recovered;
      return this.start(id);
    }
    const next = retryProvisioning(ws, isoTimestamp(this.deps.clock.now()));
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`retry of ${id} lost a concurrent update`));
    }
    return this.launchReserved(id);
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

  /**
   * Self-heal the per-owner quota counters against the actual workspace records.
   * `create` increments the counter atomically, but `finishDeleting` decrements it
   * UNCONDITIONALLY (a teardown must never block on a counter condition), so a
   * lost-race delete or an out-of-band record removal can leave a counter drifted —
   * which would weaken quota enforcement permanently. This sweep recomputes each
   * owner's true live count (a record exists from `create` until `finishDeleting`)
   * and corrects any counter that disagrees. Each correction is conditioned on the
   * value observed, so a create/delete that raced the scan is never clobbered (that
   * owner just re-converges next sweep). Returns the number of counters corrected;
   * a no-op (0) when quota counters aren't wired. */
  async reconcileOwnerCounts(): Promise<number> {
    const oc = this.deps.ownerCounts;
    if (oc === undefined) return 0;
    const actual = new Map<string, number>();
    const { data: records } = await this.deps.workspaces.scan.go({ pages: "all" });
    records.forEach((r: WorkspaceRecord) => {
      // Terminated tombstones already freed their quota at finishDeleting —
      // counting them would drift every counter upward each sweep.
      if (r.state === "terminated") return;
      actual.set(r.ownerId, (actual.get(r.ownerId) ?? 0) + 1);
    });
    const { data: counters } = await oc.scan.go({ pages: "all" });
    const stored = new Map(counters.map((c) => [c.ownerId, c.count] as const));
    const owners = new Set<string>([...actual.keys(), ...stored.keys()]);
    let corrected = 0;
    for (const owner of owners) {
      const want = actual.get(owner) ?? 0;
      const have = stored.get(owner);
      if (have === want) continue;
      try {
        await oc
          .update({ ownerId: owner })
          .set({ count: want })
          .where((attr, op) =>
            have === undefined ? op.notExists(attr.count) : op.eq(attr.count, have),
          )
          .go();
        corrected += 1;
      } catch (e) {
        if (!isVersionConflict(e)) throw e; // raced a live mutation — corrects next sweep
      }
    }
    return corrected;
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
  /** The pre-teardown snapshot step shared by stop() and finishStop(): snapshot the
   * live volume (if any) so the workspace resumes from where it stopped. Returns the
   * fresh snapshot ref, `undefined` when there's no live volume, or a conflict. */
  private async snapshotBeforeStop(
    id: WorkspaceId,
    ws: Workspace,
    version: number,
    at: IsoTimestamp,
  ): Promise<Result<{ id: SnapshotId; at: IsoTimestamp } | undefined, DomainError>> {
    if (ws.volumeId === undefined) return ok(undefined);
    const snap = await this.snapshotForTransition(id, ws.volumeId, version);
    return snap.ok ? ok({ id: snap.value, at }) : snap;
  }

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
    const snapped = await this.snapshotBeforeStop(id, ws, version, at);
    if (!snapped.ok) return snapped;
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    const next = markStopped(ws, snapped.value, at);
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
   * MANUAL, cancelable stop: move running/idle → `stopping` and return immediately
   * (the session keeps running), then converge the actual teardown after a short
   * grace via a detached {@link finishStop}. During the grace (and until the task
   * is torn down) {@link cancelStop}/{@link start} resumes the session. The
   * reconciler's `finishStopping` sweep is the backstop if this process dies before
   * the detached converge completes. Distinct from {@link stop} (the direct path
   * the idle auto-shutdown uses).
   */
  async requestStop(
    id: WorkspaceId,
    actor: string = SYSTEM_ACTOR,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    const next = markStopping(ws, isoTimestamp(this.deps.clock.now()), actor);
    if (!next.ok) return next;
    // NO billing audit here: the task keeps running (and billing) through the
    // `stopping` grace, so `session.stop` (which closes the running interval) is
    // emitted by finishStop when the task is ACTUALLY torn down — attributed to
    // `actor` via the persisted stopRequestedBy.
    try {
      await this.persistTransition(next.value, version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`stop of ${id} lost a concurrent update`));
    }
    // Convergence is driven by the long-lived server's stopping-sweep (and the
    // reconciler backstop) — NOT a detached promise here. A floating promise in a
    // Next route handler isn't reliably run after the response is sent, so a manual
    // stop could otherwise hang at `stopping` until the 5-min reconciler sweep.
    void actor;
    return ok(toWorkspaceDto(next.value));
  }

  /**
   * Converge a `stopping` workspace to `stopped`: once the cancel grace since the
   * stop request has elapsed, re-read and — only if STILL stopping — snapshot + tear
   * down + mark stopped. Re-reads a second time AFTER the (slow) snapshot and before
   * killing the task, so a cancel that lands mid-snapshot never tears down a resumed
   * session. Idempotent + safe to call repeatedly: a workspace still inside the grace
   * (or already canceled/stopped) is a no-op success — so a periodic sweep converges
   * it exactly when due. `ignoreGrace` forces immediate convergence (reconciler
   * backstop for a stuck workspace, and deterministic tests).
   */
  async finishStop(
    id: WorkspaceId,
    opts?: { ignoreGrace?: boolean },
  ): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return ok(undefined);
    if (found.ws.state !== "stopping") return ok(undefined); // canceled / already done
    // Honor the cancel window off the persisted request time (not a sleep): the
    // sweep calls this every few seconds and it no-ops until the grace elapses.
    if (opts?.ignoreGrace !== true) {
      const reqAt = found.ws.stopRequestedAt;
      const elapsedMs =
        reqAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(this.deps.clock.now()) - Date.parse(reqAt);
      if (elapsedMs < DEFAULT_STOP_GRACE_MS) return ok(undefined);
    }
    const at = isoTimestamp(this.deps.clock.now());
    // Snapshot is BEST-EFFORT here: a `stopping` workspace must ALWAYS be able to
    // converge to `stopped` (else the cancelable-stop state gets stuck forever — the
    // exact bug this fixes). If the managed volume has already gone (a compensated
    // launch, a prior teardown, a mid-flight cancel that raced), converge WITHOUT a
    // fresh snapshot — markStopped keeps the last one. A genuine storage fault (not
    // "gone") still propagates; a real version change is caught by the re-read below.
    let freshSnapshot: { id: SnapshotId; at: IsoTimestamp } | undefined;
    if (found.ws.volumeId !== undefined) {
      try {
        const snap = await this.deps.storage.createSnapshot(found.ws.volumeId);
        freshSnapshot = { id: snap.id, at };
      } catch (e) {
        if (!isResourceGoneError(e)) throw e;
      }
    }
    // Re-read: a cancel during the snapshot must abort BEFORE we kill the task.
    const recheck = await this.find(id);
    if (recheck?.ws.state !== "stopping") return ok(undefined);
    const { ws, version } = recheck;
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    const next = markStopped(ws, freshSnapshot, at);
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version, {
        action: "session.stop",
        target: id,
        actor: ws.stopRequestedBy ?? SYSTEM_ACTOR,
        detail: "scaled to zero",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      const current = await this.find(id);
      if (current?.ws.state === "stopped") return ok(undefined);
      return err(conflictError(`finish-stop of ${id} lost a concurrent update`));
    }
    return ok(undefined);
  }

  /** Cancel an in-flight manual stop: `stopping` → running (the session was never
   * torn down). Idempotent — a workspace already back to running succeeds. */
  async cancelStop(
    id: WorkspaceId,
    actor: string = SYSTEM_ACTOR,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    if (ws.state === "running" || ws.state === "idle") return ok(toWorkspaceDto(ws)); // already resumed
    const next = cancelStopping(ws, isoTimestamp(this.deps.clock.now()));
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version, {
        action: "session.recover",
        target: id,
        actor,
        detail: "manual stop canceled — session resumed",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`cancel-stop of ${id} lost a concurrent update`));
    }
    return ok(toWorkspaceDto(next.value));
  }

  /**
   * Record a workspace-editor ACCESS in the audit ledger (durable, admin-visible):
   * who reached which workspace's editor and whether it was allowed or denied. Fired
   * fire-and-forget by the proxy on the initial open + on any denial, so there is a
   * queryable trail of "who opened/attempted what" — the audit log for access, next
   * to the lifecycle events. A no-op when no audit ledger is configured.
   */
  async recordAccess(input: {
    wsId: WorkspaceId;
    actor: string;
    outcome: "allow" | "deny";
    detail: string;
  }): Promise<void> {
    const audit = this.auditItem({
      action: "session.access",
      target: input.wsId,
      actor: input.actor,
      detail: `${input.outcome}: ${input.detail}`,
    });
    if (audit !== undefined) await audit.entity.put(audit.attrs).go();
  }

  /** All workspaces mid manual-stop (the reconciler's finishStopping keep-set). */
  async listStopping(): Promise<readonly { id: WorkspaceId }[]> {
    const { data } = await this.deps.workspaces.scan.go({ pages: "all" });
    return (data as readonly WorkspaceRecord[])
      .filter((r) => r.state === "stopping")
      .map((r) => ({ id: workspaceId(r.id) }));
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
        ...(ws.editor === undefined ? {} : { editor: ws.editor }),
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

  /** Idle-agent heartbeat. `report.active === false` means "alive but unused":
   * the functional self-report is still recorded (liveness), but `lastActivity`
   * is NOT refreshed — that's what lets the reconciler's idle window age on an
   * untouched workspace and scale it to zero. Absent/`true` counts as activity
   * (a session-authed browser heartbeat IS a user action) and also wakes an
   * `idle`-state workspace. Heartbeats are frequent and harmless, so a lost
   * write race retries once before reporting conflict. */
  async heartbeat(
    id: WorkspaceId,
    report?: {
      functional?: {
        ide: boolean;
        workspace: boolean;
        disk?: { usedBytes: number; totalBytes: number };
      };
      active?: boolean;
    },
  ): Promise<Result<WorkspaceDto, DomainError>> {
    for (let attempt = 0; ; attempt++) {
      const found = await this.require(id);
      if (!found.ok) return found;
      const at = isoTimestamp(this.deps.clock.now());
      let ws = found.value.ws;
      if (report?.active !== false) {
        const active = markActivity(ws, at);
        if (!active.ok) return active;
        ws = active.value;
      }
      // Fold in the in-workspace agent's functional self-report (IDE reachable +
      // workspace writable), so the admin sees whether the desktop is actually usable.
      const next =
        report?.functional === undefined ? ws : recordFunctional(ws, report.functional, at);
      try {
        await this.persistTransition(next, found.value.version);
      } catch (e) {
        if (isVersionConflict(e) && attempt === 0) continue;
        if (isVersionConflict(e))
          return err(conflictError(`heartbeat for ${id} lost concurrent updates`));
        throw e;
      }
      return ok(toWorkspaceDto(next));
    }
  }

  /** Point-in-time snapshot of a running workspace. */
  async snapshot(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    // Snapshot is only meaningful for a live session. Without this guard a `deleting`
    // tombstone (which keeps its `volumeId` until teardown) could be snapshotted,
    // writing a fresh `latestSnapshotId` onto the record the reconciler is removing.
    if (ws.state !== "running" && ws.state !== "idle") {
      return err(conflictError(`cannot snapshot ${id}: not running (state=${ws.state})`));
    }
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
   * idempotent (safe to re-run): per the Middle data-safety policy it ensures a
   * RETAINED final snapshot survives the delete — if it still has a live volume and
   * no recent snapshot it takes a fresh retained snapshot; otherwise it marks the
   * existing latest snapshot retained — so a delete of a working session never loses
   * data. A snapshot/tag failure leaves the tombstone for a retry rather than
   * destroying data. Then it stops the task (releasing the managed volume) and
   * hard-removes the record. The retained snapshot is kept by the GC keep-set
   * (orphan-GC reaps the volume/secret/task-def after their grace, but never a
   * retained snapshot).
   */
  async finishDeleting(id: WorkspaceId): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return ok(undefined); // already gone — converged
    let { ws, version } = found;
    if (ws.state !== "deleting") return ok(undefined); // no longer deleting
    const now = isoTimestamp(this.deps.clock.now());
    // Ensure a retained data-safety snapshot capturing the FRESHEST data survives the
    // teardown. Live volume with no recent snapshot → take a fresh retained one and RECORD
    // it on the tombstone, so a re-run (after a transient delete-transaction conflict) sees
    // the recent snapshot and just re-tags it rather than taking ANOTHER one — idempotent,
    // no leaked retained snapshots (which orphan-GC never reaps). A stopped workspace has no
    // live volume, so its existing snapshot (the data) is tagged retained instead.
    try {
      if (ws.volumeId !== undefined && this.needsFreshTeardownSnapshot(ws)) {
        const snap = await this.deps.storage.createSnapshot(ws.volumeId, { retain: true });
        // The tombstone's version is stable (only finishDeleting writes it), so this
        // version-conditioned patch records the snapshot without spuriously conflicting.
        const next = recordSnapshot(ws, snap.id, now);
        await this.persistTransition(next, version);
        ws = next;
        version += 1;
      } else if (ws.latestSnapshotId !== undefined) {
        await this.deps.storage.tagSnapshotRetained(ws.latestSnapshotId);
      }
    } catch (e) {
      // Don't destroy data on a transient snapshot/tag/record failure: leave the tombstone
      // for the next sweep (surfaced via the reconciler's failure metric/alarm). The fresh
      // snapshot, if taken, is already retain-tagged so it survives until then.
      if (isVersionConflict(e)) {
        return err(conflictError(`finishDeleting ${id} lost a concurrent update`));
      }
      return err(conflictError(`final snapshot for ${id} failed: ${asMessage(e)}`));
    }
    if (ws.taskId !== undefined) {
      // Best-effort: the orphan-task reaper is the backstop if this stop fails.
      try {
        await this.deps.compute.stopTask(ws.taskId);
      } catch {
        /* reaper backstop */
      }
    }
    const oc = this.deps.ownerCounts;
    // Record teardown COMPLETION (ends billing — the volume stopped costing money;
    // the retained snapshot persists through the undelete-retention window)
    // atomically with the tombstone write, so a delete that loses the version race
    // records no terminate event. Absent only when no audit ledger is wired.
    // The record is KEPT as a `terminated` tombstone (not hard-deleted) so the
    // owner can undelete within the retention window; the purge sweep removes it
    // (and reaps the snapshot) after. Quota is freed here — undelete re-admits
    // through the same atomic counter condition as create.
    const term = this.auditItem({
      action: "session.terminated",
      target: id,
      actor: SYSTEM_ACTOR,
      detail: "teardown complete — restorable until the retention purge",
    });
    const terminated = markTerminated(ws, now);
    if (!terminated.ok) return terminated;
    const detail = toWorkspaceDetail(terminated.value);
    const clearable = ["volumeId", "taskId", "sshHost"] as const; // snapshot fields KEPT
    const cleared = clearable.filter((field) => detail[field] === undefined);
    const { id: _detailId, ...fields } = detail;
    const patched = { ...fields, version: version + 1 };
    // The version-conditioned tombstone patch is inlined per branch: inside a
    // writeTransaction the container hands back a TransactWriteEntity (whose
    // chain ends in .commit()), a different type from the plain entity used in
    // the transactionless branch — mirroring persistTransition's composition.
    // The quota decrement is UNCONDITIONAL (no `where`): it must never block the delete
    // — a counter drift only weakens enforcement and self-heals (create path +
    // reconcileOwnerCounts) — so the tombstone's own version condition is the only cancel.
    try {
      if (term !== undefined && oc !== undefined) {
        const result = await writeTransaction(
          { ws: this.deps.workspaces, oc, ev: term.entity },
          ({ ws: wsE, oc: ocE, ev }) => [
            (() => {
              const m = wsE.patch({ id }).set(patched);
              const op = cleared.length > 0 ? m.remove([...cleared]) : m;
              return op.where(({ version: v }, { eq }) => eq(v, version)).commit();
            })(),
            ocE.update({ ownerId: ws.ownerId }).subtract({ count: 1 }).commit(),
            ev.put(term.attrs).commit(),
          ],
        ).go();
        if (result.canceled) {
          return err(conflictError(`finishDeleting ${id} lost a concurrent update`));
        }
      } else if (term !== undefined) {
        const result = await writeTransaction(
          { ws: this.deps.workspaces, ev: term.entity },
          ({ ws: wsE, ev }) => [
            (() => {
              const m = wsE.patch({ id }).set(patched);
              const op = cleared.length > 0 ? m.remove([...cleared]) : m;
              return op.where(({ version: v }, { eq }) => eq(v, version)).commit();
            })(),
            ev.put(term.attrs).commit(),
          ],
        ).go();
        if (result.canceled) {
          return err(conflictError(`finishDeleting ${id} lost a concurrent update`));
        }
      } else if (oc !== undefined) {
        const result = await writeTransaction(
          { ws: this.deps.workspaces, oc },
          ({ ws: wsE, oc: ocE }) => [
            (() => {
              const m = wsE.patch({ id }).set(patched);
              const op = cleared.length > 0 ? m.remove([...cleared]) : m;
              return op.where(({ version: v }, { eq }) => eq(v, version)).commit();
            })(),
            ocE.update({ ownerId: ws.ownerId }).subtract({ count: 1 }).commit(),
          ],
        ).go();
        if (result.canceled) {
          return err(conflictError(`finishDeleting ${id} lost a concurrent update`));
        }
      } else {
        const m = this.deps.workspaces.patch({ id }).set(patched);
        const op = cleared.length > 0 ? m.remove([...cleared]) : m;
        await op.where(({ version: v }, { eq }) => eq(v, version)).go();
      }
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

  /**
   * Restore a terminated (deleted) workspace to `stopped` within the undelete
   * retention window — it wakes from its retained snapshot like any stopped
   * workspace. Quota is re-admitted through the SAME atomic counter condition as
   * create (when wired), so an undelete can't race an owner past their cap.
   */
  async undelete(
    id: WorkspaceId,
    opts?: { quotaLimit?: number; actor?: string; retentionMs?: number },
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const { ws, version } = found;
    const now = isoTimestamp(this.deps.clock.now());
    const retentionMs = opts?.retentionMs ?? DEFAULT_UNDELETE_RETENTION_MS;
    const terminatedAtMs = Date.parse(ws.terminatedAt ?? ws.lastActivity);
    if (ws.state === "terminated" && Date.parse(now) - terminatedAtMs >= retentionMs) {
      return err(
        conflictError(
          `cannot undelete ${id}: the retention window has passed (snapshot purged soon)`,
        ),
      );
    }
    const next = undeleteWorkspace(ws, now);
    if (!next.ok) return next;
    const audit = this.auditItem({
      action: "session.undelete",
      target: id,
      actor: opts?.actor ?? SYSTEM_ACTOR,
      detail: "restored from retained snapshot within the retention window",
    });
    const detail = toWorkspaceDetail(next.value);
    const clearable = ["deleteRequestedAt", "terminatedAt"] as const;
    const cleared = clearable.filter((field) => detail[field] === undefined);
    const { id: _detailId, ...fields } = detail;
    const patched = { ...fields, version: version + 1 };
    const oc = this.deps.ownerCounts;
    const quotaLimit = opts?.quotaLimit;
    try {
      if (oc !== undefined && quotaLimit !== undefined && audit !== undefined) {
        const result = await writeTransaction(
          { ws: this.deps.workspaces, oc, ev: audit.entity },
          ({ ws: wsE, oc: ocE, ev }) => [
            (() => {
              const m = wsE.patch({ id }).set(patched);
              const op = cleared.length > 0 ? m.remove([...cleared]) : m;
              return op.where(({ version: v }, { eq }) => eq(v, version)).commit();
            })(),
            ocE
              .update({ ownerId: ws.ownerId })
              .add({ count: 1 })
              .where(
                (attr, op) => `${op.notExists(attr.count)} OR ${op.lt(attr.count, quotaLimit)}`,
              )
              .commit(),
            ev.put(audit.attrs).commit(),
          ],
        ).go();
        if (result.canceled) throwForCanceledCreate(result, 1, ws.ownerId, quotaLimit);
      } else {
        await this.persistTransition(next.value, version, {
          action: "session.undelete",
          target: id,
          actor: opts?.actor ?? SYSTEM_ACTOR,
          detail: "restored from retained snapshot within the retention window",
        });
        if (oc !== undefined) {
          // No cap given: still keep the live-count counter honest (unconditional,
          // like finishDeleting's decrement; reconcileOwnerCounts self-heals drift).
          await oc.update({ ownerId: ws.ownerId }).add({ count: 1 }).go();
        }
      }
    } catch (e) {
      if (e instanceof QuotaExceededError) throw e;
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`undelete of ${id} lost a concurrent update`));
    }
    return ok(toWorkspaceDto(next.value));
  }

  /**
   * Toggle the owner's spectate flag (audited). Enabling requires a live
   * session (pure guard); disabling always succeeds. The route enforces WHO
   * may toggle (owner only).
   */
  async setShare(
    id: WorkspaceId,
    enabled: boolean,
    actor?: string,
  ): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.find(id);
    if (found === null) return err(notFoundError("workspace", id));
    const { ws, version } = found;
    const next = setShare(ws, enabled, isoTimestamp(this.deps.clock.now()));
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version, {
        action: enabled ? "session.share_enabled" : "session.share_disabled",
        target: id,
        actor: actor ?? SYSTEM_ACTOR,
        detail: enabled
          ? "spectate enabled — signed-in viewers may watch a read-only mirror"
          : "spectate disabled",
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`share toggle of ${id} lost a concurrent update`));
    }
    return ok(toWorkspaceDto(next.value));
  }

  /**
   * Purge terminated tombstones older than the retention window: reap the
   * retained snapshot (the last copy of the data — this is the irreversible
   * step the 7-day window exists to delay), then remove the record, recording
   * `session.purged` in the same transaction. Returns the number purged.
   */
  async purgeExpiredTombstones(retentionMs: number): Promise<number> {
    const { data: records } = await this.deps.workspaces.scan.go({ pages: "all" });
    const nowMs = Date.parse(this.deps.clock.now());
    let purged = 0;
    for (const r of records as readonly WorkspaceRecord[]) {
      if (r.state !== "terminated") continue;
      const terminatedAtMs = Date.parse(r.terminatedAt ?? r.lastActivity);
      if (!Number.isFinite(terminatedAtMs) || nowMs - terminatedAtMs < retentionMs) continue;
      if (await this.purgeTombstoneRecord(r, "retention window elapsed")) purged += 1;
    }
    return purged;
  }

  /**
   * Owner/admin-initiated PERMANENT delete of a terminated (deleted) workspace,
   * BEFORE its retention window elapses — the irreversible counterpart of undelete.
   * Only valid from `terminated` (a live/stopped workspace must be deleted first,
   * which snapshots + tombstones it). Reaps the retained snapshot + removes the
   * record + audits `session.purged`. The route enforces the anti-accident confirm.
   */
  async purgeNow(
    id: WorkspaceId,
    actor: string = SYSTEM_ACTOR,
  ): Promise<Result<void, DomainError>> {
    const found = await this.find(id);
    if (found === null) return ok(undefined); // already gone — idempotent
    const { ws, version } = found;
    if (ws.state !== "terminated") {
      return err(
        conflictError(
          `cannot permanently delete ${id}: it is '${ws.state}', not a deleted session`,
        ),
      );
    }
    await this.purgeTombstoneRecord(
      { id: ws.id, latestSnapshotId: ws.latestSnapshotId, version },
      `permanently deleted by ${actor}`,
      actor,
    );
    return ok(undefined);
  }

  /** Reap a terminated tombstone's retained snapshot (first — no record-less leak),
   * then remove the record + audit `session.purged`. Returns false on a lost race
   * (a concurrent undelete/purge), true when this call removed it. Shared by the
   * retention sweep and the owner-initiated `purgeNow`. */
  private async purgeTombstoneRecord(
    r: { id: string; latestSnapshotId?: string; version: number },
    reason: string,
    actor: string = SYSTEM_ACTOR,
  ): Promise<boolean> {
    // Snapshot first: if the reap fails transiently, the tombstone stays and a
    // later sweep/retry cleans it — never a record-less snapshot leak.
    if (r.latestSnapshotId !== undefined) {
      try {
        await this.deps.storage.deleteSnapshot(snapshotId(r.latestSnapshotId));
      } catch (e) {
        if (!isResourceGoneError(e)) throw e;
      }
    }
    const audit = this.auditItem({
      action: "session.purged",
      target: workspaceId(r.id),
      actor,
      detail: `tombstone and retained snapshot removed — ${reason}`,
    });
    if (audit !== undefined) {
      const result = await writeTransaction(
        { ws: this.deps.workspaces, ev: audit.entity },
        ({ ws: wsE, ev }) => [
          wsE
            .delete({ id: r.id })
            .where(({ version: v }, { eq }) => eq(v, r.version))
            .commit(),
          ev.put(audit.attrs).commit(),
        ],
      ).go();
      return !result.canceled;
    }
    await this.deps.workspaces
      .delete({ id: r.id })
      .where(({ version: v }, { eq }) => eq(v, r.version))
      .go();
    return true;
  }

  /**
   * Whether `finishDeleting` must take a FRESH snapshot of the live volume, vs. retain
   * an existing one. True when the latest snapshot is ABSENT or PREDATES this teardown
   * (a stale, pre-delete scheduled snapshot — the live volume holds newer work that a
   * delete-from-running must not lose). False when the latest snapshot was taken DURING
   * this teardown (`latestSnapshotAt >= deleteRequestedAt`) — i.e. it's the retained
   * snapshot a prior `finishDeleting` pass already captured, which a retry must merely
   * re-tag (idempotent), never re-create. Using `deleteRequestedAt` (always set on a
   * `deleting` tombstone) as the boundary makes "already captured" non-representable as
   * "needs capture", so a stuck teardown can never leak a second retained snapshot.
   */
  private needsFreshTeardownSnapshot(ws: Workspace): boolean {
    if (ws.latestSnapshotId === undefined || ws.latestSnapshotAt === undefined) return true;
    if (ws.deleteRequestedAt === undefined) return false;
    return Date.parse(ws.latestSnapshotAt) < Date.parse(ws.deleteRequestedAt);
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
    const audit = this.deps.audit;
    if (audit === undefined) {
      // The audit ledger is what makes this method idempotent: without it we can neither
      // record the event as a first-class audit row nor dedup the in-workspace guard's
      // `curl --retry` of the SAME blocked attempt — so the metric below would double-count
      // every retry. Fail loud rather than emit an unauditable, double-counted signal. (The
      // web route + reconciler always wire the ledger; this guards a misconfiguration.)
      return err(unavailableError("security-event recording requires an audit ledger"));
    }
    // Idempotent: a DETERMINISTIC event id per (workspace, tool, time bucket) + conditional
    // `create` dedupes the guard's retry of the SAME blocked attempt, so a retry writes no
    // duplicate audit row and (below) no double metric. Distinct attempts (a later bucket)
    // still record separately.
    const bucket = Math.floor(
      Date.parse(this.deps.clock.now()) / SECURITY_EVENT_BUCKET_MS,
    ).toString();
    try {
      await audit
        .create({
          id: `sec-${id}-${event.tool}-${bucket}`,
          at: this.deps.clock.now(),
          actor: "workspace",
          action: `security.${event.kind}`,
          target: id,
          detail: event.tool,
        })
        .go();
    } catch (e) {
      // The deterministic id already exists → this is a retry of an already-recorded
      // attempt. Idempotent success: don't double-count the metric below.
      if (isVersionConflict(e)) return ok(undefined);
      throw e;
    }
    // Exactly one new audit row was created → count the privilege-attempt metric exactly once.
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

  /** Insert a brand-new workspace record (fails if the id already exists), recording
   * its `session.create` event in the same transaction — and, when quota enforcement
   * is wired (`ownerCounts` + `quotaLimit`), an ATOMIC per-owner counter increment
   * guarded by `attribute_not_exists(count) OR count < limit` in that SAME transaction,
   * so a create past the cap cancels (→ {@link QuotaExceededError}) instead of racing
   * past a read-then-create check. */
  private async persistNew(
    ws: Workspace,
    audit: LifecycleAudit,
    quotaLimit?: number,
  ): Promise<void> {
    const item = { ...toWorkspaceDetail(ws), version: 0 };
    const auditItem = this.auditItem(audit);
    if (auditItem === undefined) {
      await this.deps.workspaces.create(item).go();
      return;
    }
    const oc = this.deps.ownerCounts;
    if (oc !== undefined && quotaLimit !== undefined) {
      const result = await writeTransaction(
        { ws: this.deps.workspaces, ev: auditItem.entity, oc },
        ({ ws: wsE, ev, oc: ocE }) => [
          wsE.create(item).commit(),
          ev.put(auditItem.attrs).commit(),
          ocE
            .update({ ownerId: ws.ownerId })
            .add({ count: 1 })
            .where((attr, op) => `${op.notExists(attr.count)} OR ${op.lt(attr.count, quotaLimit)}`)
            .commit(),
        ],
      ).go();
      // The counter op is the 3rd item; if it (and only it) failed its condition, the
      // owner is at their cap — a quota rejection, not a generic conflict.
      if (result.canceled) throwForCanceledCreate(result, 2, ws.ownerId, quotaLimit);
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
