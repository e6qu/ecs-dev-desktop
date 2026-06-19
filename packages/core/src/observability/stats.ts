// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceState } from "../lifecycle/workspace-state-machine";

export interface WorkspaceStats {
  readonly total: number;
  /** Count per lifecycle state (every state present, 0 when none). */
  readonly byState: Record<WorkspaceState, number>;
  /** Running + idle — the fleet currently consuming compute. */
  readonly active: number;
}

/** A fresh all-zero tally. The `Record<WorkspaceState, number>` literal must list
 * every state, so adding a state is a compile error here (no silent drift, no cast). */
function zeroByState(): Record<WorkspaceState, number> {
  return {
    provisioning: 0,
    running: 0,
    idle: 0,
    stopped: 0,
    deleting: 0,
    terminated: 0,
    error: 0,
  };
}

/** Pure: tally a list of workspace states for the admin Overview. */
export function tallyWorkspaceStates(states: readonly WorkspaceState[]): WorkspaceStats {
  const byState = zeroByState();
  for (const s of states) byState[s] += 1;
  return { total: states.length, byState, active: byState.running + byState.idle };
}
