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
  | "terminated"
  | "error";

export type WorkspaceEvent =
  | "provisioned" // task is up and reachable
  | "activity" // user/editor/ssh activity observed
  | "idleTimeout" // no activity past threshold
  | "stop" // snapshot + tear down the task
  | "wake" // bring a stopped workspace back
  | "terminate" // permanent deletion
  | "fail"; // unrecoverable error

const TRANSITIONS: Record<WorkspaceState, Partial<Record<WorkspaceEvent, WorkspaceState>>> = {
  provisioning: { provisioned: "running", fail: "error", terminate: "terminated" },
  running: { idleTimeout: "idle", stop: "stopped", fail: "error", terminate: "terminated" },
  idle: { activity: "running", stop: "stopped", fail: "error", terminate: "terminated" },
  stopped: { wake: "provisioning", terminate: "terminated", fail: "error" },
  terminated: {},
  error: { terminate: "terminated" },
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
