// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Functional core for control-plane scale-to-zero. Pure decisions (data in →
 * decision out, no I/O, time passed in per §6.10) shared by both halves of the
 * loop: the reconciler's idle-shutdown sweep (scale the control-plane ECS service
 * to 0 after a quiet period) and the wake listener (scale it back up on demand).
 */
import type { IsoTimestamp } from "../domain/ids";

/**
 * The desired-count decision for the control-plane ECS service.
 * - `hold`: leave the current desired count unchanged.
 * - `scale-to-zero`: the service is running but has been idle past the threshold.
 * - `wake`: the service is at zero and must scale up to `to` active replicas.
 */
export type ControlPlaneScaleDecision =
  | { readonly action: "hold"; readonly reason: string }
  | { readonly action: "scale-to-zero"; readonly reason: string }
  | { readonly action: "wake"; readonly to: number; readonly reason: string };

export interface ControlPlaneIdleInput {
  /** The service's current desired count (0 when scaled to zero). */
  readonly currentDesired: number;
  /** Instant of the last real user request the control plane recorded, or
   * `undefined` when none has been recorded since it last woke. */
  readonly lastActivityAt: IsoTimestamp | undefined;
  readonly now: IsoTimestamp;
  /** Quiet period before scale-to-zero (e.g. 15 min). */
  readonly idleThresholdMs: number;
}

/**
 * Idle-shutdown decision (reconciler sweep). Scales the control plane to zero only
 * when it is actually running (`currentDesired > 0`) AND a recorded activity instant
 * is older than the threshold. An absent `lastActivityAt` is a HOLD, not an
 * immediate shutdown: a freshly-woken control plane stamps its activity on wake, so
 * `undefined` means "just started, no request yet" — killing it then would fight a
 * wake in progress. A future-dated activity (writer clock skew) also holds.
 */
export function decideControlPlaneIdle(input: ControlPlaneIdleInput): ControlPlaneScaleDecision {
  if (input.currentDesired <= 0) {
    return { action: "hold", reason: "already scaled to zero" };
  }
  if (input.lastActivityAt === undefined) {
    return { action: "hold", reason: "no activity recorded yet (startup grace)" };
  }
  const idleForMs = Date.parse(input.now) - Date.parse(input.lastActivityAt);
  if (Number.isNaN(idleForMs)) {
    return { action: "hold", reason: "unparseable activity/now timestamp" };
  }
  if (idleForMs >= input.idleThresholdMs) {
    return {
      action: "scale-to-zero",
      reason: `idle for ${String(idleForMs)}ms (>= ${String(input.idleThresholdMs)}ms)`,
    };
  }
  return { action: "hold", reason: `last active ${String(Math.max(0, idleForMs))}ms ago` };
}

/**
 * Wake decision (wake listener). Returns the scale-up target when the service is
 * below its active replica count, or `hold` when it is already at/above it — so a
 * concurrent wake (two users hit the cold entry at once) is idempotent.
 */
export function decideControlPlaneWake(input: {
  readonly currentDesired: number;
  readonly activeDesired: number;
}): ControlPlaneScaleDecision {
  if (input.activeDesired <= 0) {
    return { action: "hold", reason: "active desired count is not positive" };
  }
  if (input.currentDesired >= input.activeDesired) {
    return { action: "hold", reason: `already at ${String(input.currentDesired)} desired` };
  }
  return {
    action: "wake",
    to: input.activeDesired,
    reason: `waking ${String(input.currentDesired)} → ${String(input.activeDesired)}`,
  };
}
