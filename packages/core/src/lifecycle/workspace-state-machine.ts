// SPDX-License-Identifier: AGPL-3.0-or-later
import { conflictError, type DomainError } from "../domain/errors";
import { err, ok, type Result } from "../result";

/**
 * Workspace lifecycle. Scale-to-zero is modelled as
 * running → idle → stopped (snapshot taken) → provisioning (hydrate) → running.
 */
export type WorkspaceState =
  | "provisioning"
  | "running"
  | "idle"
  | "stopped"
  // A manual stop is in progress (cancelable): the workspace is still running its
  // task while a short grace + snapshot/teardown converges it to `stopped`. `start`
  // (or an explicit cancel) reverts it to `running` before the task is torn down.
  | "stopping"
  // Tombstone: a delete was requested (desiredState="deleted") and the reconciler is
  // converging teardown. The record persists until teardown finishes, so an
  // interrupted delete is resumable (vs the old transactional row-delete).
  | "deleting"
  | "terminated"
  | "error";

export type WorkspaceEvent =
  | "provisioned" // task is up and reachable
  | "activity" // user/editor/ssh activity observed
  | "idleTimeout" // no activity past threshold
  | "stop" // snapshot + tear down the task (direct: idle auto-stop + the stopping converge)
  | "requestStop" // manual stop → `stopping` (cancelable)
  | "cancelStop" // stopping → running (cancel a manual stop before teardown)
  | "wake" // bring a stopped workspace back
  | "terminate" // permanent deletion (legacy synchronous path; kept for back-compat)
  | "requestDelete" // mark for deletion → `deleting` tombstone (reconciler finishes)
  | "recover" // error → stopped when a snapshot exists (self-recovery)
  | "undelete" // terminated → stopped within the retention window (snapshot restores it)
  | "retry" // error → provisioning: relaunch after a failed create/launch
  | "fail"; // unrecoverable error

const TRANSITIONS: Record<WorkspaceState, Partial<Record<WorkspaceEvent, WorkspaceState>>> = {
  // `stop` cancels an in-flight wake (claim made, launch failed/aborted) back to
  // scaled-to-zero — the snapshot is untouched, so the workspace stays wake-able.
  // `requestDelete` from any live/stopped/error state moves to the `deleting`
  // tombstone; the reconciler tears down convergently and then removes the record.
  provisioning: {
    provisioned: "running",
    stop: "stopped",
    fail: "error",
    terminate: "terminated",
    requestDelete: "deleting",
  },
  running: {
    idleTimeout: "idle",
    stop: "stopped",
    requestStop: "stopping",
    fail: "error",
    terminate: "terminated",
    requestDelete: "deleting",
  },
  idle: {
    activity: "running",
    stop: "stopped",
    requestStop: "stopping",
    fail: "error",
    terminate: "terminated",
    requestDelete: "deleting",
  },
  // Manual stop in progress: the converge finishes it (`stop` → stopped), or the
  // user cancels (`cancelStop` → running) before the task is torn down.
  stopping: {
    stop: "stopped",
    cancelStop: "running",
    fail: "error",
    terminate: "terminated",
    requestDelete: "deleting",
  },
  stopped: {
    wake: "provisioning",
    terminate: "terminated",
    fail: "error",
    requestDelete: "deleting",
  },
  // A delete in progress; the only forward move is `terminate` (finish → tombstone kept).
  deleting: { terminate: "terminated" },
  // Terminated keeps its retained snapshot for the undelete-retention window
  // (default 7 days): `undelete` restores it to `stopped` (wake-able). The
  // reconciler purges tombstones (and reaps their snapshots) past the window,
  // after which the record is gone and nothing can leave `terminated`.
  terminated: { undelete: "stopped" },
  // Self-recovery: an `error` workspace with a snapshot can `recover` to `stopped`
  // (wake-able again); otherwise it can only be deleted.
  error: {
    recover: "stopped",
    retry: "provisioning",
    terminate: "terminated",
    requestDelete: "deleting",
  },
};

/**
 * Compute the next state for an event. An illegal transition is a `conflict`
 * domain error (returned, never thrown), so callers must handle it.
 */
export function transition(
  state: WorkspaceState,
  event: WorkspaceEvent,
): Result<WorkspaceState, DomainError> {
  const next = TRANSITIONS[state][event];
  return next === undefined
    ? err(conflictError(`invalid transition: cannot '${event}' while '${state}'`))
    : ok(next);
}

export function can(state: WorkspaceState, event: WorkspaceEvent): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

/** A user-initiated lifecycle operation offered for a workspace in the UI. */
export type WorkspaceAction =
  | "start"
  | "stop"
  | "cancelStop"
  | "snapshot"
  | "delete"
  | "undelete"
  | "retry";

/**
 * The lifecycle actions valid from a state — the single source of truth for which
 * buttons the UI may offer. Lives in the core (not mirrored client-side) so it rides
 * the workspace DTO and a reskinned frontend renders actions from data rather than
 * re-implementing the state machine. The exhaustive switch makes a new state a compile
 * error here.
 */
export function workspaceActions(state: WorkspaceState): readonly WorkspaceAction[] {
  switch (state) {
    case "running":
    case "idle":
      return ["snapshot", "stop", "delete"];
    case "stopping":
      // A manual stop is converging; the only user action is to cancel it (which
      // resumes the still-running session) — delete stays available.
      return ["cancelStop", "delete"];
    case "stopped":
      return ["start", "delete"];
    case "provisioning":
      return ["delete"];
    case "error":
      // A failed launch is retryable in place (relaunch, or recover+start when a
      // snapshot survives) — the status page offers it next to delete.
      return ["retry", "delete"];
    case "deleting":
      // Being torn down — no user action until the tombstone lands.
      return [];
    case "terminated":
      // Restorable from the retained snapshot until the retention purge; the
      // service enforces the window + snapshot presence (a clear conflict
      // message past either), the UI just offers the button.
      return ["undelete"];
  }
}
