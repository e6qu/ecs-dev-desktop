// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceState } from "../lifecycle/workspace-state-machine";

export interface WorkspaceStats {
  readonly total: number;
  /** Count per lifecycle state (every state present, 0 when none). */
  readonly byState: Record<WorkspaceState, number>;
  /** Running + idle — the fleet currently consuming compute. */
  readonly active: number;
}

const ALL_STATES: readonly WorkspaceState[] = [
  "provisioning",
  "running",
  "idle",
  "stopped",
  "terminated",
  "error",
];

/** Pure: tally a list of workspace states for the admin Overview. */
export function tallyWorkspaceStates(states: readonly WorkspaceState[]): WorkspaceStats {
  const byState = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<
    WorkspaceState,
    number
  >;
  for (const s of states) byState[s] += 1;
  return { total: states.length, byState, active: byState.running + byState.idle };
}
