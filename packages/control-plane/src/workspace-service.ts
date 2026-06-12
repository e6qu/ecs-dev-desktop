// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto, WorkspaceInspectionDto } from "@edd/api-contracts";
import {
  assertNever,
  assertTerminable,
  baseImage,
  conflictError,
  deriveWorkspaceTimeline,
  err,
  isoTimestamp,
  markActivity,
  markStarted,
  markStopped,
  markTaskLost,
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
  volumeId,
  workspaceId,
  type BaseImage,
  type Clock,
  type ComputeProvider,
  type DomainError,
  type IsoTimestamp,
  type OwnerId,
  type ReferencedStorage,
  type Result,
  type SnapshotCandidate,
  type SnapshotId,
  type StorageProvider,
  type VolumeId,
  type Workspace,
  type WorkspaceId,
  type WorkspaceState,
} from "@edd/core";
import type { WorkspaceEntity } from "@edd/db";

import { toWorkspaceDetail, toWorkspaceDto } from "./dto";

export interface WorkspaceServiceDeps {
  workspaces: WorkspaceEntity;
  storage: StorageProvider;
  compute: ComputeProvider;
  clock: Clock;
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
  baseImage: string;
  state: WorkspaceState;
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

/** Brand a persisted record into a domain object (imperative-shell boundary). */
function toWorkspace(r: WorkspaceRecord): Workspace {
  return {
    id: workspaceId(r.id),
    ownerId: ownerId(r.ownerId),
    baseImage: baseImage(r.baseImage),
    state: r.state,
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

  async create(input: { ownerId: OwnerId; baseImage: BaseImage }): Promise<WorkspaceDto> {
    const id = newWorkspaceId();
    const at = isoTimestamp(this.deps.clock.now());
    // ECS creates the managed EBS volume at task launch and returns its id.
    const task = await this.deps.compute.runTask({ workspaceId: id, baseImage: input.baseImage });
    const ws = provision({
      id,
      ownerId: input.ownerId,
      baseImage: input.baseImage,
      volumeId: task.volumeId,
      taskId: task.id,
      at,
      sshHost: task.sshHost,
    });
    try {
      await this.persistNew(ws);
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

  /** Workspaces with a live volume that the reconciler may snapshot on schedule. */
  async listSnapshotCandidates(): Promise<SnapshotCandidate[]> {
    const records = await this.recordsByStates(["running", "idle"]);
    return records
      .filter((r) => r.volumeId !== undefined)
      .map((r) => ({
        id: workspaceId(r.id),
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

  /** Fetch all workspace records in the given lifecycle states (fully paginated). */
  private async recordsByStates(states: readonly WorkspaceState[]): Promise<WorkspaceRecord[]> {
    const pages = await Promise.all(
      states.map((state) => this.deps.workspaces.query.byState({ state }).go({ pages: "all" })),
    );
    return pages.flatMap((page) => page.data.map((r: WorkspaceRecord) => r));
  }

  /** Scale to zero: snapshot the managed volume, then stop the task (which
   * releases the volume). Snapshot first — stopping the task tears the volume down. */
  async stop(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    const validated = transition(ws.state, "stop"); // validate-first, before any I/O
    if (!validated.ok) return validated;
    const at = isoTimestamp(this.deps.clock.now());
    let freshSnapshot: { id: SnapshotId; at: IsoTimestamp } | undefined;
    if (ws.volumeId !== undefined) {
      const snap = await this.deps.storage.createSnapshot(ws.volumeId);
      freshSnapshot = { id: snap.id, at };
    }
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    const next = markStopped(ws, freshSnapshot, at);
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version);
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

  /** Wake from a snapshot: launch a task whose managed volume is hydrated from it. */
  async start(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    // validate-first (wake → provisioned), before any I/O.
    const woken = transition(ws.state, "wake");
    if (!woken.ok) return woken;
    const provisioned = transition(woken.value, "provisioned");
    if (!provisioned.ok) return provisioned;
    if (ws.latestSnapshotId === undefined) {
      return err(conflictError(`cannot start ${id}: no snapshot to hydrate from`));
    }
    const at = isoTimestamp(this.deps.clock.now());
    const task = await this.deps.compute.runTask({
      workspaceId: ws.id,
      baseImage: ws.baseImage,
      fromSnapshot: ws.latestSnapshotId,
    });
    const next = markStarted(ws, task.volumeId, task.id, at, task.sshHost);
    if (!next.ok) return next;
    try {
      await this.persistTransition(next.value, version);
    } catch (e) {
      if (isVersionConflict(e)) {
        // Lost the wake race: another writer (a concurrent connect/start) won.
        // Stop OUR freshly launched task so it cannot leak, then return the
        // winner's state if it serves the caller's intent (idempotent wake).
        await this.deps.compute.stopTask(task.id);
        const current = await this.find(id);
        if (current === null) return err(notFoundError("workspace", id));
        const { state } = current.ws;
        if (state === "running" || state === "idle" || state === "provisioning") {
          return ok(toWorkspaceDto(current.ws));
        }
        return err(conflictError(`wake of ${id} lost a concurrent update (now ${state})`));
      }
      // Crash-consistency: persistence failed outright — the task launched but
      // no record references it. Stop it, then surface the original error.
      await this.deps.compute.stopTask(task.id);
      throw e;
    }
    return ok(toWorkspaceDto(next.value));
  }

  /** Wake-on-connect: ensure the workspace is reachable for an incoming connection
   * (e.g. SSH via the gateway). Idempotent — a running/idle workspace is returned
   * as-is, a scaled-to-zero one is woken from its snapshot, an in-flight wake is
   * returned for the caller to poll, and a terminal one is rejected. */
  async connect(id: WorkspaceId): Promise<Result<WorkspaceDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws } = found.value;
    const action = planConnect(ws.state);
    switch (action) {
      case "ready":
      case "pending":
        return ok(toWorkspaceDto(ws));
      case "wake":
        return this.start(id);
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
    const snap = await this.deps.storage.createSnapshot(ws.volumeId);
    const next = recordSnapshot(ws, snap.id, isoTimestamp(this.deps.clock.now()));
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
      await this.persistTransition(next.value, version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      // A concurrent writer (user action) advanced the record — defer to it;
      // the next sweep re-evaluates from the fresh state.
      return err(conflictError(`drift reconcile of ${id} lost a concurrent update`));
    }
    return ok({ lost: true, workspace: toWorkspaceDto(next.value) });
  }

  /** Permanently delete the workspace and its runtime resources. */
  async remove(id: WorkspaceId): Promise<Result<void, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const { ws, version } = found.value;
    const terminable = assertTerminable(ws);
    if (!terminable.ok) return terminable;
    // Version-conditioned, like every other transition: a delete racing a wake
    // must NOT remove the record out from under the task the wake just launched
    // (an unconditional delete left that task orphaned). Claim the deletion FIRST
    // via the conditional write; only the winner then tears down resources.
    try {
      await this.deps.workspaces
        .delete({ id })
        .where(({ version: v }, { eq }) => eq(v, version))
        .go();
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`delete of ${id} lost a concurrent update`));
    }
    // The record is gone, so this delete owns teardown. Stopping the task
    // releases its managed volume. The retained snapshot is left to GC — it is
    // now unreferenced and reaped after the grace window. (GC is the single
    // storage reaper; deleting it synchronously here would race a concurrent
    // wake hydrating a new volume from that very snapshot.)
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
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

  /** Insert a brand-new workspace record (fails if the id already exists). */
  private async persistNew(ws: Workspace): Promise<void> {
    await this.deps.workspaces.create({ ...toWorkspaceDetail(ws), version: 0 }).go();
  }

  /** Persist a lifecycle transition, conditioned on the version the caller's
   * read observed: a concurrent writer makes this throw a version conflict
   * instead of silently overwriting (and possibly leaking a real task).
   * Cleared optional bindings (volume/task on stop) are removed explicitly —
   * an update, unlike PutItem, keeps attributes it isn't told about. */
  private async persistTransition(ws: Workspace, observedVersion: number): Promise<void> {
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
    let mutation = this.deps.workspaces
      .patch({ id })
      .set({ ...fields, version: observedVersion + 1 });
    if (cleared.length > 0) mutation = mutation.remove([...cleared]);
    await mutation.where(({ version }, { eq }) => eq(version, observedVersion)).go();
  }
}
