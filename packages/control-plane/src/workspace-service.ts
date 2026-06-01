// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import {
  assertTerminable,
  baseImage,
  isoTimestamp,
  markStarted,
  markStopped,
  newWorkspaceId,
  ownerId,
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
  type StorageProvider,
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
    const volume = await this.deps.storage.createVolume();
    const task = await this.deps.compute.runTask({
      workspaceId: id,
      baseImage: input.baseImage,
      volumeId: volume.id,
    });
    const ws = provision({
      id,
      ownerId: input.ownerId,
      baseImage: input.baseImage,
      volumeId: volume.id,
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
    const states: readonly WorkspaceState[] = ["running", "idle"];
    const pages = await Promise.all(
      states.map((state) => this.deps.workspaces.query.byState({ state }).go()),
    );
    return pages.flatMap((page) =>
      page.data.map((r: WorkspaceRecord) => ({
        id: workspaceId(r.id),
        lastActivity: isoTimestamp(r.lastActivity),
      })),
    );
  }

  /** Scale to zero: snapshot the volume, tear it down, stop the task. */
  async stop(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    transition(ws.state, "stop"); // validate-first (pure); throws on illegal
    const at = isoTimestamp(this.deps.clock.now());
    let snapshot = ws.latestSnapshotId;
    if (ws.volumeId !== undefined) {
      snapshot = (await this.deps.storage.createSnapshot(ws.volumeId)).id;
      await this.deps.storage.deleteVolume(ws.volumeId);
    }
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
    const next = markStopped(ws, snapshot, at);
    await this.persist(next);
    return toWorkspaceDto(next);
  }

  /** Wake from a snapshot: hydrate a fresh volume, run a new task. */
  async start(id: WorkspaceId): Promise<WorkspaceDto> {
    const ws = await this.require(id);
    transition(transition(ws.state, "wake"), "provisioned"); // validate-first
    if (ws.latestSnapshotId === undefined) {
      throw new Error(`cannot start ${id}: no snapshot to hydrate from`);
    }
    const at = isoTimestamp(this.deps.clock.now());
    const volume = await this.deps.storage.createVolume({ fromSnapshot: ws.latestSnapshotId });
    const task = await this.deps.compute.runTask({
      workspaceId: ws.id,
      baseImage: ws.baseImage,
      volumeId: volume.id,
    });
    const next = markStarted(ws, volume.id, task.id, at);
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
    if (ws.volumeId !== undefined) await this.deps.storage.deleteVolume(ws.volumeId);
    if (ws.taskId !== undefined) await this.deps.compute.stopTask(ws.taskId);
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
      })
      .go();
  }
}
