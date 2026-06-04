// SPDX-License-Identifier: AGPL-3.0-or-later
import { transition, type WorkspaceState } from "../lifecycle/workspace-state-machine";
import { err, map, ok, type Result } from "../result";
import { conflictError, type DomainError } from "./errors";
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
  /** When the latest snapshot was taken — drives scheduled-snapshot timing. */
  readonly latestSnapshotAt?: IsoTimestamp;
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

/**
 * Compute the stopped (scaled-to-zero) workspace. Throws if not stoppable.
 * `freshSnapshot` is the snapshot just taken while stopping (if the workspace had
 * a live volume); when absent the prior snapshot reference is carried over.
 */
export function markStopped(
  ws: Workspace,
  freshSnapshot: { id: SnapshotId; at: IsoTimestamp } | undefined,
  at: IsoTimestamp,
): Result<Workspace, DomainError> {
  return map(transition(ws.state, "stop"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    latestSnapshotId: freshSnapshot?.id ?? ws.latestSnapshotId,
    latestSnapshotAt: freshSnapshot?.at ?? ws.latestSnapshotAt,
    volumeId: undefined,
    taskId: undefined,
  }));
}

/** Compute the running workspace after waking from a snapshot. Err if invalid. */
export function markStarted(
  ws: Workspace,
  volumeId: VolumeId,
  taskId: TaskId,
  at: IsoTimestamp,
): Result<Workspace, DomainError> {
  const woken = transition(ws.state, "wake");
  if (!woken.ok) return woken;
  return map(transition(woken.value, "provisioned"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    volumeId,
    taskId,
  }));
}

/** Record a point-in-time snapshot on a running workspace. */
export function recordSnapshot(ws: Workspace, snapshot: SnapshotId, at: IsoTimestamp): Workspace {
  return { ...ws, latestSnapshotId: snapshot, latestSnapshotAt: at, lastActivity: at };
}

/**
 * Record user/editor/SSH activity (an idle-agent heartbeat): refresh `lastActivity`
 * so the reconciler doesn't scale the workspace to zero, and wake it from idle.
 * Only an active workspace can have activity — throws otherwise.
 */
export function markActivity(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  if (ws.state !== "running" && ws.state !== "idle") {
    return err(conflictError(`cannot record activity while '${ws.state}'`));
  }
  if (ws.state === "idle") {
    return map(transition(ws.state, "activity"), (state) => ({ ...ws, state, lastActivity: at }));
  }
  return ok({ ...ws, state: ws.state, lastActivity: at });
}

/** Ok if the workspace may be terminated; a conflict domain error otherwise. */
export function assertTerminable(ws: Workspace): Result<void, DomainError> {
  return map(transition(ws.state, "terminate"), () => undefined);
}
