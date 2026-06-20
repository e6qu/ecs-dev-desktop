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
  | "stop" // snapshot + tear down the task
  | "wake" // bring a stopped workspace back
  | "terminate" // permanent deletion (legacy synchronous path; kept for back-compat)
  | "requestDelete" // mark for deletion → `deleting` tombstone (reconciler finishes)
  | "recover" // error → stopped when a snapshot exists (self-recovery)
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
    fail: "error",
    terminate: "terminated",
    requestDelete: "deleting",
  },
  idle: {
    activity: "running",
    stop: "stopped",
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
  // A delete in progress; the only forward move is `terminate` (finish → record removed).
  deleting: { terminate: "terminated" },
  terminated: {},
  // Self-recovery: an `error` workspace with a snapshot can `recover` to `stopped`
  // (wake-able again); otherwise it can only be deleted.
  error: { recover: "stopped", terminate: "terminated", requestDelete: "deleting" },
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
export type WorkspaceAction = "start" | "stop" | "snapshot" | "delete";

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
    case "stopped":
      return ["start", "delete"];
    case "provisioning":
    case "error":
      return ["delete"];
    case "deleting":
    case "terminated":
      // Already being torn down / gone — no further user actions.
      return [];
  }
}
