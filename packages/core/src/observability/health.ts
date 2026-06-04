// SPDX-License-Identifier: AGPL-3.0-or-later
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
