// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reconciler: idle detection + scale-to-zero (skeleton). The decision logic is
 * pure and unit-tested here; the effects (ECS StopTask, snapshot) are applied
 * through ports (`StorageProvider` and a forthcoming `ComputeProvider`) so the
 * loop stays testable without AWS.
 */

export type ReconcileAction = "stop" | "noop";

export interface IdleInput {
  state: "running" | "idle";
  /** Milliseconds since last observed activity. */
  msSinceActivity: number;
  /** Idle threshold in milliseconds before scale-to-zero. */
  idleThresholdMs: number;
}

export function decideAction(input: IdleInput): ReconcileAction {
  if (input.msSinceActivity >= input.idleThresholdMs) return "stop";
  return "noop";
}
