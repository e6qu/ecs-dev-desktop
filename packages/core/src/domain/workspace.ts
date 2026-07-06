// SPDX-License-Identifier: AGPL-3.0-or-later
import { transition, type WorkspaceState } from "../lifecycle/workspace-state-machine";
import { err, map, ok, type Result } from "../result";
import { DEFAULT_EDITOR, type EditorKind } from "./editor";
import { conflictError, type DomainError } from "./errors";
import type {
  BaseImage,
  Email,
  IsoTimestamp,
  OwnerId,
  SnapshotId,
  TaskId,
  VolumeId,
  WorkspaceId,
} from "./ids";

/** Durable convergence intent (see {@link Workspace.desiredState}). */
export type DesiredState = "present" | "deleted";

/** The owner's role recorded on a workspace at create time. Mirrors `@edd/authz`'s `Role` (kept a
 * standalone union here because `@edd/authz` depends on `@edd/core`, so core can't import it). */
export type WorkspaceOwnerRole = "viewer" | "member" | "admin";

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
  /** Owner's email — the identity the proxy matches a caller against for
   * per-workspace access. Optional: records created before the
   * field, or by paths without a session email, have none (proxy fails closed
   * for non-admins). */
  readonly ownerEmail?: Email;
  /** The owner's role at create time — lets the admin quota view flag a workspace against its
   * owner's per-role limit. Forward-only (like {@link Workspace.ownerEmail}): records created
   * before the field have none. */
  readonly ownerRole?: WorkspaceOwnerRole;
  /** Git repo cloned into the session at first boot ("one repo per session").
   * Absent for an empty workspace. */
  readonly repoUrl?: string;
  readonly baseImage: BaseImage;
  /** Which editor this workspace serves — drives `EDD_EDITOR_MODE` at launch. Absent on records
   * created before the field ⇒ treated as the default (OpenVSCode). */
  readonly editor?: EditorKind;
  readonly state: WorkspaceState;
  /** Durable intent, independent of the observed `state`: whether this workspace
   * should exist (`present`) or be torn down (`deleted`). The reconciler converges
   * toward it — recovering a half-broken `present` workspace forward, or finishing
   * teardown of a `deleted` one — so a partial create/delete always reaches a
   * consistent end. Absent on records created before the field ⇒ treated `present`. */
  readonly desiredState?: DesiredState;
  /** When a delete was requested (the `deleting` tombstone began) — drives the
   * retention window and the stuck-delete alarm. */
  readonly deleteRequestedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly lastActivity: IsoTimestamp;
  readonly volumeId?: VolumeId;
  readonly taskId?: TaskId;
  readonly latestSnapshotId?: SnapshotId;
  /** When the latest snapshot was taken — drives scheduled-snapshot timing. */
  readonly latestSnapshotAt?: IsoTimestamp;
  /** Private IP of the running task's ENI — used by the SSH gateway to forward. Absent when stopped. */
  readonly sshHost?: string;
  /** Last functional self-report from the in-workspace agent: is the desktop actually
   * USABLE (the IDE reachable, the workspace writable), beyond merely "task running".
   * `ok` = all probes passed; `degraded` = at least one failed (detail says which).
   * Absent until the first report. */
  readonly functional?: FunctionalStatus;
  readonly functionalDetail?: string;
  readonly functionalAt?: IsoTimestamp;
  /** Home-volume usage from the same self-report (bytes), when the agent measured it. */
  readonly diskUsedBytes?: number;
  readonly diskTotalBytes?: number;
  /** When a manual stop was requested (state became `stopping`) — the converge
   * finishes the stop after a short grace unless the user cancels first. */
  readonly stopRequestedAt?: IsoTimestamp;
  /** WHO requested the manual stop — so the async converge attributes the
   * `session.stop` audit to the user who initiated it, not the system sweep. */
  readonly stopRequestedBy?: string;
  /** When teardown finished (state became `terminated`) — starts the undelete
   * retention window; the purge sweep removes the tombstone (and reaps its
   * retained snapshot) once it is older than the retention. */
  readonly terminatedAt?: IsoTimestamp;
  /** Owner-controlled spectate flag: signed-in `viewer`+ users may watch a live
   * read-only mirror of the owner's editor session while true. Default off;
   * cleared automatically when the session stops/deletes (sharing never
   * outlives the live session it exposed). */
  readonly shareEnabled?: boolean;
  readonly shareEnabledAt?: IsoTimestamp;
}

/** Functional usability of a running workspace, self-reported by the in-workspace agent. */
export type FunctionalStatus = "ok" | "degraded";

export interface ProvisionParams {
  id: WorkspaceId;
  ownerId: OwnerId;
  ownerEmail?: Email;
  ownerRole?: WorkspaceOwnerRole;
  repoUrl?: string;
  baseImage: BaseImage;
  editor?: EditorKind;
  volumeId: VolumeId;
  taskId: TaskId;
  at: IsoTimestamp;
  sshHost?: string;
}

/** A freshly-provisioned, running workspace. */
/**
 * The instant-create record: persisted (and its URL handed to the browser)
 * BEFORE any compute is launched, so navigation to the workspace page is
 * immediate. State starts at `provisioning` with no runtime bindings; the
 * detached launch binds them via {@link markProvisioned} (→ running), or
 * {@link markProvisioningFailed} records why it could not.
 */
export function reserve(
  params: Omit<ProvisionParams, "volumeId" | "taskId" | "sshHost">,
): Workspace {
  return {
    id: params.id,
    ownerId: params.ownerId,
    ownerEmail: params.ownerEmail,
    ownerRole: params.ownerRole,
    repoUrl: params.repoUrl,
    baseImage: params.baseImage,
    editor: params.editor ?? DEFAULT_EDITOR,
    state: "provisioning",
    desiredState: "present",
    createdAt: params.at,
    lastActivity: params.at,
  };
}

export function provision(params: ProvisionParams): Workspace {
  return {
    id: params.id,
    ownerId: params.ownerId,
    ownerEmail: params.ownerEmail,
    ownerRole: params.ownerRole,
    repoUrl: params.repoUrl,
    baseImage: params.baseImage,
    editor: params.editor ?? DEFAULT_EDITOR,
    state: "running",
    desiredState: "present",
    createdAt: params.at,
    lastActivity: params.at,
    volumeId: params.volumeId,
    taskId: params.taskId,
    sshHost: params.sshHost,
  };
}

/**
 * Compute the stopped (scaled-to-zero) workspace. Throws if not stoppable.
 * `freshSnapshot` is the snapshot just taken while stopping (if the workspace had
 * a live volume); when absent the prior snapshot reference is carried over.
 */
/**
 * Begin a MANUAL stop: running/idle → `stopping`. The task keeps running (no
 * teardown yet) so the stop is cancelable; the converge (finishStop) snapshots +
 * tears down after a short grace, or {@link cancelStopping} resumes it. Distinct
 * from the direct {@link markStopped} the idle auto-shutdown uses.
 */
export function markStopping(
  ws: Workspace,
  at: IsoTimestamp,
  by?: string,
): Result<Workspace, DomainError> {
  return map(transition(ws.state, "requestStop"), (state) => ({
    ...ws,
    state,
    stopRequestedAt: at,
    stopRequestedBy: by,
    // Deliberately keeps volumeId/taskId/sshHost — the session is still running.
  }));
}

/** Cancel an in-flight manual stop: `stopping` → running (the session was never
 * torn down). Clears the stop request. */
export function cancelStopping(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  return map(transition(ws.state, "cancelStop"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    stopRequestedAt: undefined,
    stopRequestedBy: undefined,
  }));
}

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
    sshHost: undefined,
    stopRequestedAt: undefined,
    stopRequestedBy: undefined,
    // Sharing never outlives the live session it exposed.
    shareEnabled: undefined,
    shareEnabledAt: undefined,
  }));
}

/**
 * Teardown finished: keep the record as a `terminated` tombstone (with its
 * retained snapshot reference) so the owner can undelete it within the retention
 * window; the purge sweep removes it after. Runtime bindings are cleared.
 */
export function markTerminated(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  return map(transition(ws.state, "terminate"), (state) => ({
    ...ws,
    state,
    terminatedAt: at,
    volumeId: undefined,
    taskId: undefined,
    sshHost: undefined,
    shareEnabled: undefined,
    shareEnabledAt: undefined,
  }));
}

/**
 * Restore a terminated workspace to `stopped` (wake-able from its retained
 * snapshot). Pure guards: legal transition + a snapshot to restore from. The
 * retention-window check is the shell's (it owns the clock and the configured
 * retention); quota re-admission is enforced atomically by the service.
 */
export function undeleteWorkspace(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  if (ws.latestSnapshotId === undefined) {
    return err(conflictError(`cannot undelete ${ws.id}: no retained snapshot to restore from`));
  }
  return map(transition(ws.state, "undelete"), (state) => ({
    ...ws,
    state,
    desiredState: "present" as const,
    deleteRequestedAt: undefined,
    terminatedAt: undefined,
    lastActivity: at,
  }));
}

/** The states in which a spectate mirror can exist (a live editor session). */
const SHAREABLE_STATES: readonly WorkspaceState[] = ["running", "idle", "provisioning"];

/**
 * Toggle the owner's spectate flag. Enabling requires a live (or launching)
 * session — there is nothing to mirror otherwise; disabling is always legal
 * (it must never be refusable). Pure; the route enforces WHO may toggle.
 */
export function setShare(
  ws: Workspace,
  enabled: boolean,
  at: IsoTimestamp,
): Result<Workspace, DomainError> {
  if (enabled && !SHAREABLE_STATES.includes(ws.state)) {
    return err(
      conflictError(
        `cannot enable spectate while '${ws.state}': only a live session can be mirrored`,
      ),
    );
  }
  return ok({
    ...ws,
    shareEnabled: enabled,
    shareEnabledAt: enabled ? at : undefined,
  });
}

/**
 * Phase 1 of waking: claim the wake by moving stopped → provisioning, BEFORE any
 * task is launched. Persisting this conditionally (optimistic version) lets exactly
 * one concurrent waker proceed to launch — the rest lose the claim and wait — so a
 * burst of connects never starts a herd of tasks. No bindings yet (the volume/task
 * arrive in phase 2). Err if the workspace is not wakeable.
 */
export function markWaking(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  return map(transition(ws.state, "wake"), (state) => ({ ...ws, state, lastActivity: at }));
}

/**
 * Phase 2 of waking: commit provisioning → running once the task is up, recording
 * its volume/task/host. Err if the workspace is not provisioning.
 */
export function markProvisioned(
  ws: Workspace,
  volumeId: VolumeId,
  taskId: TaskId,
  at: IsoTimestamp,
  sshHost?: string,
): Result<Workspace, DomainError> {
  return map(transition(ws.state, "provisioned"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    volumeId,
    taskId,
    sshHost,
  }));
}

/**
 * A detached launch (or retry) failed: move to `error` carrying the reason.
 * The reason rides `functionalDetail` — the DTO's existing free-text "why is
 * this workspace not usable" slot the status page already renders.
 */
export function markProvisioningFailed(
  ws: Workspace,
  reason: string,
  at: IsoTimestamp,
): Result<Workspace, DomainError> {
  return map(transition(ws.state, "fail"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    functional: "degraded" as const,
    functionalDetail: reason,
    functionalAt: at,
  }));
}

/**
 * User-initiated retry of a failed launch: error → provisioning, clearing the
 * failure report. The shell relaunches compute (or recover+start when a
 * snapshot survives — its data must not be discarded by a fresh volume).
 */
export function retryProvisioning(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  return map(transition(ws.state, "retry"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    functional: undefined,
    functionalDetail: undefined,
    functionalAt: undefined,
  }));
}

/** Record a point-in-time snapshot on a running workspace. */
export function recordSnapshot(ws: Workspace, snapshot: SnapshotId, at: IsoTimestamp): Workspace {
  return { ...ws, latestSnapshotId: snapshot, latestSnapshotAt: at, lastActivity: at };
}

/**
 * Reconcile an out-of-band task death (crash, Fargate eviction, manual stop):
 * the compute platform released the managed volume with the task, so the
 * record must stop claiming live bindings. With a snapshot the workspace is
 * recoverable (→ `stopped`, wake-able); without one nothing can be restored
 * (→ `error`, surfaced honestly instead of pretending to be reachable).
 * Only an active, task-bound workspace can lose its task — err otherwise.
 */
export function markTaskLost(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  if (ws.state !== "provisioning" && ws.state !== "running" && ws.state !== "idle") {
    return err(conflictError(`cannot reconcile task loss for ${ws.id}: workspace is ${ws.state}`));
  }
  if (ws.taskId === undefined) {
    return err(conflictError(`cannot reconcile task loss for ${ws.id}: no task bound`));
  }
  return ok({
    ...ws,
    state: ws.latestSnapshotId === undefined ? "error" : "stopped",
    lastActivity: at,
    volumeId: undefined,
    taskId: undefined,
    sshHost: undefined,
  });
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

/**
 * Record the in-workspace agent's functional self-report — whether the desktop is
 * actually usable (IDE reachable on :3000, workspace dir writable), not merely that the
 * task is running. Pure: derives an `ok`/`degraded` status + a human detail from the
 * probe booleans. The caller (heartbeat) only invokes this on a running/idle workspace.
 */
export function recordFunctional(
  ws: Workspace,
  probes: { ide: boolean; workspace: boolean; disk?: { usedBytes: number; totalBytes: number } },
  at: IsoTimestamp,
): Workspace {
  const failures: string[] = [];
  if (!probes.ide) failures.push("IDE unreachable on :3000");
  if (!probes.workspace) failures.push("workspace not writable");
  return {
    ...ws,
    functional: failures.length === 0 ? "ok" : "degraded",
    functionalDetail: failures.length === 0 ? "IDE + workspace healthy" : failures.join("; "),
    functionalAt: at,
    // Disk usage rides the same report; an omitted measurement keeps the last one
    // (a transient df failure must not blank a previously known figure).
    ...(probes.disk === undefined
      ? {}
      : { diskUsedBytes: probes.disk.usedBytes, diskTotalBytes: probes.disk.totalBytes }),
  };
}

/** Ok if the workspace may be terminated; a conflict domain error otherwise. */
export function assertTerminable(ws: Workspace): Result<void, DomainError> {
  return map(transition(ws.state, "requestDelete"), () => undefined);
}

/**
 * Mark a workspace for deletion: move to the `deleting` tombstone with
 * `desiredState="deleted"`. The record persists (it is NOT row-deleted here) so the
 * reconciler can converge teardown of the task/volume/snapshot/secret/task-def and
 * then hard-remove it — making an interrupted delete resumable. Idempotent: a
 * workspace already `deleting` is returned unchanged. Err if it can't be deleted.
 */
export function markDeleting(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  if (ws.state === "deleting") return ok(ws);
  return map(transition(ws.state, "requestDelete"), (state) => ({
    ...ws,
    state,
    desiredState: "deleted",
    deleteRequestedAt: at,
    shareEnabled: undefined,
    shareEnabledAt: undefined,
  }));
}

/**
 * Self-recovery: move an `error` workspace back to `stopped` (wake-able) when it has
 * a recoverable snapshot. A workspace with no snapshot stays `error` (genuinely
 * unrecoverable) — never fabricate a recovery without data. Err if not in `error`.
 */
export function markRecovered(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  if (ws.state !== "error") {
    return err(conflictError(`cannot recover ${ws.id}: workspace is ${ws.state}, not error`));
  }
  if (ws.latestSnapshotId === undefined) {
    return err(conflictError(`cannot recover ${ws.id}: no snapshot to restore from`));
  }
  return map(transition(ws.state, "recover"), (state) => ({
    ...ws,
    state,
    lastActivity: at,
    volumeId: undefined,
    taskId: undefined,
    sshHost: undefined,
  }));
}

/** A workspace is unrecoverable when it is in `error` with no snapshot to restore
 * from — it cannot move forward to working, only be deleted. */
export function isUnrecoverable(ws: Workspace): boolean {
  return ws.state === "error" && ws.latestSnapshotId === undefined;
}

/**
 * Reverse drift: the snapshot a `stopped`/`error` workspace would restore from has
 * vanished out-of-band (manually deleted). The workspace can never wake, so move it
 * to `error` and clear the dangling snapshot reference — honestly unrecoverable
 * (surfaced + deletable) rather than a `stopped` record that silently fails every
 * wake. Only meaningful for a stopped/error workspace that claims a snapshot.
 */
export function markSnapshotLost(ws: Workspace, at: IsoTimestamp): Result<Workspace, DomainError> {
  if (ws.state !== "stopped" && ws.state !== "error") {
    return err(conflictError(`cannot mark snapshot lost for ${ws.id}: workspace is ${ws.state}`));
  }
  if (ws.latestSnapshotId === undefined) {
    return err(conflictError(`cannot mark snapshot lost for ${ws.id}: no snapshot referenced`));
  }
  return ok({
    ...ws,
    state: "error",
    lastActivity: at,
    latestSnapshotId: undefined,
    latestSnapshotAt: undefined,
  });
}
