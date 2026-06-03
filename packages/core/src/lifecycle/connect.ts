// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceState } from "./workspace-state-machine";

/**
 * Connect-time wake decision (the control-plane half of wake-on-connect). When a
 * user reaches a workspace (e.g. SSH via the gateway), the control plane must
 * ensure it is running before forwarding. This pure function maps the current
 * state to the action the connect path should take — keeping the decision testable
 * and free of I/O (the shell performs the wake).
 *
 * - `ready`       — already reachable (running, or idle so still up); connect now.
 * - `wake`        — scaled to zero; hydrate from the snapshot and run a task.
 * - `pending`     — a wake is already in flight; the caller polls until running.
 * - `unavailable` — terminal/failed; connecting is impossible.
 */
export type ConnectAction = "ready" | "wake" | "pending" | "unavailable";

export function planConnect(state: WorkspaceState): ConnectAction {
  switch (state) {
    case "running":
    case "idle":
      return "ready";
    case "stopped":
      return "wake";
    case "provisioning":
      return "pending";
    case "terminated":
    case "error":
      return "unavailable";
  }
}
