// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import {
  assertTerminable,
  baseImage,
  isoTimestamp,
  markActivity,
  markStarted,
  markStopped,
  newWorkspaceId,
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
  type IsoTimestamp,
  type OwnerId,
  type ReferencedStorage,
  type SnapshotCandidate,
  type SnapshotId,
  type StorageProvider,
  type VolumeId,
  type Workspace,
  type WorkspaceId,
  type WorkspaceState,
} from "@edd/core";
import type { WorkspaceEntity } from "@edd/db";

import { toWorkspaceDto } from "./dto";

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

export class WorkspaceNotFoundError extends Error {
  constructor(readonly id: WorkspaceId) {
    super(`workspace not found: ${id}`);
    this.name = "WorkspaceNotFoundError";
  }
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
    });
    await this.persist(ws);
    return toWorkspaceDto(ws);
  }

  async list(filter?: { ownerId?: OwnerId }): Promise<WorkspaceDto[]> {
    const owner = filter?.ownerId;
    const { data } = owner
      ? await this.deps.workspaces.query.byOwner({ ownerId: owner }).go()
      : await this.deps.workspaces.scan.go();
    return data.map((r: WorkspaceRecord) => toWorkspaceDto(toWorkspace(r)));
  }

  async get(id: WorkspaceId): Promise<WorkspaceDto | null> {
    const ws = await this.find(id);
    return ws === null ? null : toWorkspaceDto(ws);
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
  async stop(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    transition(ws.state, "stop"); // validate-first (pure); throws on illegal
    const at = isoTimestamp(this.deps.clock.now());
    let freshSnapshot: { id: SnapshotId; at: IsoTimestamp } | undefined;
    if (ws.volumeId !== undefined) {
      const snap = await this.deps.storage.createSnapshot(ws.volumeId);
      freshSnapshot = { id: snap.id, at };
    }
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    const next = markStopped(ws, freshSnapshot, at);
    await this.persist(next);
    return toWorkspaceDto(next);
  }

  /** Wake from a snapshot: launch a task whose managed volume is hydrated from it. */
  async start(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    transition(transition(ws.state, "wake"), "provisioned"); // validate-first
    if (ws.latestSnapshotId === undefined) {
      throw new Error(`cannot start ${id}: no snapshot to hydrate from`);
    }
    const at = isoTimestamp(this.deps.clock.now());
    const task = await this.deps.compute.runTask({
      workspaceId: ws.id,
      baseImage: ws.baseImage,
      fromSnapshot: ws.latestSnapshotId,
    });
    const next = markStarted(ws, task.volumeId, task.id, at);
    await this.persist(next);
    return toWorkspaceDto(next);
  }

  /** Wake-on-connect: ensure the workspace is reachable for an incoming connection
   * (e.g. SSH via the gateway). Idempotent — a running/idle workspace is returned
   * as-is, a scaled-to-zero one is woken from its snapshot, an in-flight wake is
   * returned for the caller to poll, and a terminal one is rejected. */
  async connect(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    const action = planConnect(ws.state);
    switch (action) {
      case "ready":
      case "pending":
        return toWorkspaceDto(ws);
      case "wake":
        return this.start(id);
      case "unavailable":
        throw new Error(`cannot connect to ${id}: workspace is ${ws.state}`);
    }
  }

  /** Idle-agent heartbeat: record activity so the reconciler doesn't scale the
   * workspace to zero (and wake it from idle). */
  async heartbeat(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    const next = markActivity(ws, isoTimestamp(this.deps.clock.now()));
    await this.persist(next);
    return toWorkspaceDto(next);
  }

  /** Point-in-time snapshot of a running workspace. */
  async snapshot(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    if (ws.volumeId === undefined) throw new Error(`cannot snapshot ${id}: no active volume`);
    const snap = await this.deps.storage.createSnapshot(ws.volumeId);
    const next = recordSnapshot(ws, snap.id, isoTimestamp(this.deps.clock.now()));
    await this.persist(next);
    return toWorkspaceDto(next);
  }

  /** Permanently delete the workspace and its runtime resources. */
  async remove(id: WorkspaceId): Promise<void> {
    const ws = await this.require(id);
    assertTerminable(ws);
    // Running: stopping the task releases its managed volume. Stopped: the volume
    // was already released; reap the retained snapshot.
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    if (ws.latestSnapshotId !== undefined)
      await this.deps.storage.deleteSnapshot(ws.latestSnapshotId);
    await this.deps.workspaces.delete({ id }).go();
  }

  private async find(id: WorkspaceId): Promise<Workspace | null> {
    const { data } = await this.deps.workspaces.get({ id }).go();
    return data === null ? null : toWorkspace(data);
  }

  private async require(id: WorkspaceId): Promise<Workspace> {
    const ws = await this.find(id);
    if (ws === null) throw new WorkspaceNotFoundError(id);
    return ws;
  }

  /** Upsert the domain workspace; PutItem replaces the item so cleared optional
   * bindings (volume/task on stop) are removed. */
  private async persist(ws: Workspace): Promise<void> {
    await this.deps.workspaces
      .put({
        id: ws.id,
        ownerId: ws.ownerId,
        baseImage: ws.baseImage,
        state: ws.state,
        createdAt: ws.createdAt,
        lastActivity: ws.lastActivity,
        ...(ws.volumeId === undefined ? {} : { volumeId: ws.volumeId }),
        ...(ws.taskId === undefined ? {} : { taskId: ws.taskId }),
        ...(ws.latestSnapshotId === undefined ? {} : { latestSnapshotId: ws.latestSnapshotId }),
        ...(ws.latestSnapshotAt === undefined ? {} : { latestSnapshotAt: ws.latestSnapshotAt }),
      })
      .go();
  }
}
