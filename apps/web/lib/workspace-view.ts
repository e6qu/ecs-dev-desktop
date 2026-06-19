// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceStateDto } from "@edd/api-contracts";

interface StatusMeta {
  label: string;
  pulse: boolean;
}

const STATUS: Record<WorkspaceStateDto, StatusMeta> = {
  provisioning: { label: "provisioning", pulse: true },
  running: { label: "running", pulse: true },
  idle: { label: "idle", pulse: false },
  stopped: { label: "stopped", pulse: false },
  deleting: { label: "deleting", pulse: true },
  error: { label: "error", pulse: false },
  terminated: { label: "terminated", pulse: false },
};

export function statusMeta(state: WorkspaceStateDto): StatusMeta {
  return STATUS[state];
}

export type WorkspaceAction = "start" | "stop" | "snapshot" | "delete";

// The non-`undefined` return type already makes this switch exhaustive: add a
// WorkspaceState and the missing case is a compile error here. (No `assertNever`
// import, which would pull @edd/core into the client bundle.)
/** Lifecycle actions valid from a state — mirrors the control-plane state machine. */
export function availableActions(state: WorkspaceStateDto): readonly WorkspaceAction[] {
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
