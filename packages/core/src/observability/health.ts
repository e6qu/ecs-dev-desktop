// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_RECONCILER_STALE_MS } from "../domain/constants";
import type { IsoTimestamp } from "../domain/ids";

/**
 * Health of a single dependency / subsystem. `unknown` = not checkable in this
 * environment (e.g. a real-cloud-only check while running on the sim) — it never
 * drags the overall status down; only `degraded`/`down` do.
 */
export type HealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface ComponentHealth {
  readonly component: string;
  readonly status: HealthStatus;
  readonly detail?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly components: readonly ComponentHealth[];
  readonly checkedAt: IsoTimestamp;
}

// `unknown` ranks with `ok` for the overall roll-up — a not-yet-checkable
// component should not make the system look unhealthy.
const SEVERITY: Record<HealthStatus, number> = { ok: 0, unknown: 0, degraded: 1, down: 2 };

/**
 * Pure: the reconciler's health from its last-successful-sweep heartbeat. No
 * heartbeat → `unknown` (never run, or pre-AWS); a sweep within `staleAfterMs`
 * → `ok`; older → `degraded` (the scale-to-zero/snapshot/GC loop has stalled).
 */
export function reconcilerHealthFromHeartbeat(
  lastRunAt: IsoTimestamp | undefined,
  now: IsoTimestamp,
  staleAfterMs: number = DEFAULT_RECONCILER_STALE_MS,
): ComponentHealth {
  if (lastRunAt === undefined) {
    return { component: "reconciler", status: "unknown", detail: "no sweep recorded yet" };
  }
  const ageMs = Date.parse(now) - Date.parse(lastRunAt);
  if (ageMs <= staleAfterMs) {
    return { component: "reconciler", status: "ok", detail: `last sweep ${lastRunAt}` };
  }
  return {
    component: "reconciler",
    status: "degraded",
    detail: `last sweep ${lastRunAt} (>${String(staleAfterMs)}ms ago)`,
  };
}

/** Pure: roll component checks up to one overall status (the worst observed). */
export function summarizeHealth(
  components: readonly ComponentHealth[],
  checkedAt: IsoTimestamp,
): HealthReport {
  const worst = components.reduce<HealthStatus>(
    (acc, c) => (SEVERITY[c.status] > SEVERITY[acc] ? c.status : acc),
    "ok",
  );
  return { status: worst, components, checkedAt };
}
