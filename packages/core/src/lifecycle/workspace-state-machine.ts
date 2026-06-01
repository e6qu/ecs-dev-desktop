// SPDX-License-Identifier: AGPL-3.0-or-later

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

export class InvalidTransitionError extends Error {
  constructor(
    readonly state: WorkspaceState,
    readonly event: WorkspaceEvent,
  ) {
    super(`invalid transition: cannot '${event}' while '${state}'`);
    this.name = "InvalidTransitionError";
  }
}

const TRANSITIONS: Record<WorkspaceState, Partial<Record<WorkspaceEvent, WorkspaceState>>> = {
  provisioning: { provisioned: "running", fail: "error", terminate: "terminated" },
  running: { idleTimeout: "idle", stop: "stopped", fail: "error", terminate: "terminated" },
  idle: { activity: "running", stop: "stopped", fail: "error", terminate: "terminated" },
  stopped: { wake: "provisioning", terminate: "terminated", fail: "error" },
  terminated: {},
  error: { terminate: "terminated" },
};

export function transition(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  const next = TRANSITIONS[state][event];
  if (next === undefined) throw new InvalidTransitionError(state, event);
  return next;
}

export function can(state: WorkspaceState, event: WorkspaceEvent): boolean {
  return TRANSITIONS[state][event] !== undefined;
}
