// SPDX-License-Identifier: AGPL-3.0-or-later
import { transition, type WorkspaceState } from "../lifecycle/workspace-state-machine";
import type {
  BaseImage,
  IsoTimestamp,
  OwnerId,
  SnapshotId,
  TaskId,
  VolumeId,
  WorkspaceId,
} from "./ids";

/**
 * The Workspace domain object — the typed value passed across boundaries (never
 * a bare dict). All identifiers are branded. This and the pure functions below
 * are the **functional core**: data in, a new `Workspace` out, no I/O. The
 * imperative shell (`WorkspaceService`) performs the storage/compute effects and
 * then calls these to compute the next state.
 */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly ownerId: OwnerId;
  readonly baseImage: BaseImage;
  readonly state: WorkspaceState;
  readonly createdAt: IsoTimestamp;
  readonly lastActivity: IsoTimestamp;
  readonly volumeId?: VolumeId;
  readonly taskId?: TaskId;
  readonly latestSnapshotId?: SnapshotId;
}

export interface ProvisionParams {
  id: WorkspaceId;
  ownerId: OwnerId;
  baseImage: BaseImage;
  volumeId: VolumeId;
  taskId: TaskId;
  at: IsoTimestamp;
}

/** A freshly-provisioned, running workspace. */
export function provision(params: ProvisionParams): Workspace {
  return {
    id: params.id,
    ownerId: params.ownerId,
    baseImage: params.baseImage,
    state: "running",
    createdAt: params.at,
    lastActivity: params.at,
    volumeId: params.volumeId,
    taskId: params.taskId,
  };
}

/** Compute the stopped (scaled-to-zero) workspace. Throws if not stoppable. */
export function markStopped(
  ws: Workspace,
  snapshot: SnapshotId | undefined,
  at: IsoTimestamp,
): Workspace {
  const state: WorkspaceState = transition(ws.state, "stop");
  return {
    ...ws,
    state,
    lastActivity: at,
    latestSnapshotId: snapshot ?? ws.latestSnapshotId,
    volumeId: undefined,
    taskId: undefined,
  };
}

/** Compute the running workspace after waking from a snapshot. Throws if invalid. */
export function markStarted(
  ws: Workspace,
  volumeId: VolumeId,
  taskId: TaskId,
  at: IsoTimestamp,
): Workspace {
  const state: WorkspaceState = transition(transition(ws.state, "wake"), "provisioned");
  return { ...ws, state, lastActivity: at, volumeId, taskId };
}

/** Record a point-in-time snapshot on a running workspace. */
export function recordSnapshot(ws: Workspace, snapshot: SnapshotId, at: IsoTimestamp): Workspace {
  return { ...ws, latestSnapshotId: snapshot, lastActivity: at };
}

/** Validate that the workspace may be terminated; throws otherwise. */
export function assertTerminable(ws: Workspace): void {
  transition(ws.state, "terminate");
}
