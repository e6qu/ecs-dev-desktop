// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import type { WorkspaceDto } from "@edd/api-contracts";
import type { Clock, ComputeProvider, StorageProvider } from "@edd/core";
import { transition } from "@edd/core";
import type { WorkspaceEntity } from "@edd/db";

import { toWorkspaceDto } from "./dto";

export interface WorkspaceServiceDeps {
  workspaces: WorkspaceEntity;
  storage: StorageProvider;
  compute: ComputeProvider;
  clock: Clock;
}

export class WorkspaceNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`workspace not found: ${id}`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * Orchestrates the workspace lifecycle across persistence (ElectroDB), the
 * lifecycle state machine, and the storage/compute ports. All effects go through
 * ports, so this is fully exercisable against DynamoDB Local + fakes — no AWS.
 */
export class WorkspaceService {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  async create(input: { ownerId: string; baseImage: string }): Promise<WorkspaceDto> {
    const { storage, compute, clock, workspaces } = this.deps;
    const id = `ws-${randomUUID()}`;
    const now = clock.now();
    const volume = await storage.createVolume();
    const task = await compute.runTask({
      workspaceId: id,
      baseImage: input.baseImage,
      volumeId: volume.id,
    });
    const { data } = await workspaces
      .create({
        id,
        ownerId: input.ownerId,
        baseImage: input.baseImage,
        state: "running",
        lastActivity: now,
        createdAt: now,
        volumeId: volume.id,
        taskId: task.id,
      })
      .go();
    return toWorkspaceDto(data);
  }

  async list(filter?: { ownerId?: string }): Promise<WorkspaceDto[]> {
    const { workspaces } = this.deps;
    if (filter?.ownerId) {
      const { data } = await workspaces.query.byOwner({ ownerId: filter.ownerId }).go();
      return data.map(toWorkspaceDto);
    }
    const { data } = await workspaces.scan.go();
    return data.map(toWorkspaceDto);
  }

  async get(id: string): Promise<WorkspaceDto | null> {
    const { data } = await this.deps.workspaces.get({ id }).go();
    return data ? toWorkspaceDto(data) : null;
  }

  private async require(id: string) {
    const { data } = await this.deps.workspaces.get({ id }).go();
    if (!data) throw new WorkspaceNotFoundError(id);
    return data;
  }

  /** Scale to zero: snapshot the volume, tear it down, stop the task. */
  async stop(id: string): Promise<WorkspaceDto> {
    const rec = await this.require(id);
    const next = transition(rec.state, "stop");
    const { storage, compute, clock, workspaces } = this.deps;

    let latestSnapshotId = rec.latestSnapshotId;
    if (rec.volumeId) {
      latestSnapshotId = (await storage.createSnapshot(rec.volumeId)).id;
      await storage.deleteVolume(rec.volumeId);
    }
    if (rec.taskId) await compute.stopTask(rec.taskId);

    const { data } = await workspaces
      .patch({ id })
      .set({ state: next, lastActivity: clock.now(), latestSnapshotId })
      .remove(["volumeId", "taskId"])
      .go({ response: "all_new" });
    return toWorkspaceDto(data);
  }

  /** Wake from a snapshot: hydrate a fresh volume, run a new task. */
  async start(id: string): Promise<WorkspaceDto> {
    const rec = await this.require(id);
    const running = transition(transition(rec.state, "wake"), "provisioned");
    const { storage, compute, clock, workspaces } = this.deps;
    if (!rec.latestSnapshotId) {
      throw new Error(`cannot start ${id}: no snapshot to hydrate from`);
    }
    const volume = await storage.createVolume({ fromSnapshot: rec.latestSnapshotId });
    const task = await compute.runTask({
      workspaceId: id,
      baseImage: rec.baseImage,
      volumeId: volume.id,
    });
    const { data } = await workspaces
      .patch({ id })
      .set({ state: running, lastActivity: clock.now(), volumeId: volume.id, taskId: task.id })
      .go({ response: "all_new" });
    return toWorkspaceDto(data);
  }

  /** Point-in-time snapshot of a running workspace. */
  async snapshot(id: string): Promise<WorkspaceDto> {
    const rec = await this.require(id);
    if (!rec.volumeId) throw new Error(`cannot snapshot ${id}: no active volume`);
    const snap = await this.deps.storage.createSnapshot(rec.volumeId);
    const { data } = await this.deps.workspaces
      .patch({ id })
      .set({ latestSnapshotId: snap.id, lastActivity: this.deps.clock.now() })
      .go({ response: "all_new" });
    return toWorkspaceDto(data);
  }

  /** Permanently delete the workspace and its runtime resources. */
  async remove(id: string): Promise<void> {
    const rec = await this.require(id);
    transition(rec.state, "terminate");
    if (rec.volumeId) await this.deps.storage.deleteVolume(rec.volumeId);
    if (rec.taskId) await this.deps.compute.stopTask(rec.taskId);
    await this.deps.workspaces.delete({ id }).go();
  }
}
