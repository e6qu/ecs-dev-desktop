// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RunRateProjection } from "@edd/core";

/**
 * The `e6qu.monitoring/v2` observation this deployment publishes to Shauth.
 *
 * Shauth reads each registered application's monitoring endpoint and renders
 * the result. It used to read none of them: `managed_apps.monitoring_url` was
 * stored and returned but never fetched, so nothing collected from any app.
 *
 * v2 is v1 with the cost estimate made optional, because most applications have
 * no price. This one does: it runs Fargate tasks and EBS volumes on a real
 * account, so the estimate is REQUIRED here and `buildObservation` cannot
 * produce a document without one.
 */

const SCHEMA_VERSION = "e6qu.monitoring/v2";
const PRICING_BASIS = "public-on-demand";
const HOURS_PER_MONTH = 730;
const HOURS_PER_DAY = 24;

/** Exactly the exclusions the contract requires, no more and no fewer. */
const PRICE_EXCLUSIONS = [
  "credits",
  "free_tier",
  "reservations",
  "savings_plans",
  "taxes",
] as const;

type MetricStatus = "available" | "unavailable" | "not_applicable";
type ResourceHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ObservationMetric {
  readonly name: string;
  readonly label: string;
  readonly unit: string;
  readonly status: MetricStatus;
  readonly value?: number;
}

interface ObservationResource {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly health: ResourceHealth;
  readonly metrics: readonly ObservationMetric[];
}

interface ObservationCostLineItem {
  readonly name: string;
  readonly hourly: number;
  readonly monthly: number;
}

interface ObservationCostEstimate {
  readonly currency: "USD";
  readonly basis: typeof PRICING_BASIS;
  readonly hours_per_month: number;
  readonly hourly: number;
  readonly daily: number;
  readonly monthly: number;
  readonly excludes: readonly string[];
  readonly limitations: readonly string[];
  readonly line_items: readonly ObservationCostLineItem[];
}

export interface Observation {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly observed_at: string;
  readonly resources: readonly ObservationResource[];
  readonly cost_estimate: ObservationCostEstimate;
}

/** An `ok`/`unknown` health rolls up as healthy; the contract has no `ok`. */
function mapHealth(status: "ok" | "degraded" | "down" | "unknown"): ResourceHealth {
  switch (status) {
    case "ok":
      return "healthy";
    case "degraded":
      return "degraded";
    case "down":
      return "unhealthy";
    case "unknown":
      return "unknown";
  }
}

/**
 * A measured value, or an explicit "unavailable" when it could not be read.
 *
 * A metric that cannot be measured is published as `unavailable` WITHOUT a
 * value, never as 0. Zero is a real reading here -- it is exactly what a
 * healthy container's memory ceiling counter reports -- so substituting it for
 * "unknown" would turn an unreadable counter into a clean bill of health.
 */
export function metric(
  name: string,
  label: string,
  unit: string,
  value: number | undefined,
): ObservationMetric {
  if (value === undefined) return { name, label, unit, status: "unavailable" };
  // A NaN, infinite or negative reading is a defect in whatever produced it --
  // counters and byte counts are domain-nonnegative. Publishing it as
  // "unavailable" would launder a broken producer into a legitimate-looking
  // "not measurable", and the bug would never surface. Fail loudly instead.
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`metric ${name} produced a non-representable value: ${String(value)}`);
  }
  return { name, label, unit, status: "available", value };
}

export interface ObservationInput {
  readonly observedAt: Date;
  readonly health: {
    readonly status: "ok" | "degraded" | "down" | "unknown";
    readonly components: readonly {
      readonly component: string;
      readonly status: "ok" | "degraded" | "down" | "unknown";
      readonly detail?: string;
    }[];
  };
  readonly cluster: {
    readonly name: string;
    readonly status: string;
    readonly runningTasks: number;
    readonly pendingTasks: number;
    readonly activeServices: number;
  };
  readonly fleet: { readonly total: number; readonly active: number };
  /** Self-reported cgroup pressure; undefined fields publish as unavailable. */
  readonly self: {
    readonly memoryCurrentBytes?: number;
    readonly memoryMaxBytes?: number;
    readonly ceilingHits?: number;
    readonly socketThrottles?: number;
  };
  readonly runRate: RunRateProjection;
  /** Workspaces the cost model could not price, and why. */
  readonly unpriced: readonly { readonly workspaceId: string; readonly reason: string }[];
}

/** The cost estimate, whose totals must agree with its line items. */
function costEstimate(
  runRate: RunRateProjection,
  unpriced: ObservationInput["unpriced"],
): ObservationCostEstimate {
  const lineItems: ObservationCostLineItem[] = [
    {
      name: "Workspaces (every non-terminated workspace running at once)",
      hourly: runRate.workspacesUsdPerHour,
      monthly: runRate.workspacesUsdPerHour * HOURS_PER_MONTH,
    },
    {
      name: "Control plane (always-on Fargate)",
      hourly: runRate.controlPlaneUsdPerHour,
      monthly: runRate.controlPlaneUsdPerHour * HOURS_PER_MONTH,
    },
  ];
  // Every limitation here is a real gap in the number above. The contract
  // requires at least one and rejects a blank -- an estimate that discloses
  // nothing is worse than no estimate, because it reads as complete.
  const limitations = [
    "A forward-looking run-rate, not billed spend: it projects every non-terminated workspace running simultaneously, including stopped ones, because that is what resuming them would cost.",
    "Snapshot storage is excluded from the running rate: a snapshot bills while a workspace is stopped, which the projection does not model.",
    "Public on-demand rates with no discounts, so Savings Plans, Reserved capacity and private pricing are not reflected.",
    ...unpriced.map(
      (entry) => `Workspace ${entry.workspaceId} is not priced and is missing from this total: ${entry.reason}`,
    ),
  ];
  return {
    currency: "USD",
    basis: PRICING_BASIS,
    hours_per_month: HOURS_PER_MONTH,
    hourly: runRate.totalUsdPerHour,
    daily: runRate.totalUsdPerHour * HOURS_PER_DAY,
    monthly: lineItems.reduce((sum, item) => sum + item.monthly, 0),
    excludes: [...PRICE_EXCLUSIONS],
    limitations,
    line_items: lineItems,
  };
}

/** Pure: assemble the published observation. */
export function buildObservation(input: ObservationInput): Observation {
  const resources: ObservationResource[] = [
    {
      id: "control-plane",
      name: "Control plane",
      kind: "control-plane",
      health: mapHealth(input.health.status),
      metrics: [
        metric("cluster.running_tasks", "Running tasks", "tasks", input.cluster.runningTasks),
        metric("cluster.pending_tasks", "Pending tasks", "tasks", input.cluster.pendingTasks),
        metric("cluster.active_services", "Active services", "services", input.cluster.activeServices),
      ],
    },
    {
      id: "workspace-fleet",
      name: "Workspace fleet",
      kind: "workspace-fleet",
      health: "healthy",
      metrics: [
        metric("fleet.total", "Workspaces", "workspaces", input.fleet.total),
        metric("fleet.active", "Active workspaces", "workspaces", input.fleet.active),
        metric("cost.run_rate_hourly", "Projected run-rate", "USD/hour", input.runRate.totalUsdPerHour),
      ],
    },
    {
      // The signal that was invisible: under cgroup v2 a container over
      // memory.max is throttled, not killed, so it never restarts and never
      // fails a health check. It can report this about itself.
      id: "web-container",
      name: "Web container",
      kind: "container",
      health: containerHealth(input.self),
      metrics: [
        metric("memory.current_bytes", "Memory in use", "bytes", input.self.memoryCurrentBytes),
        metric("memory.limit_bytes", "Memory limit", "bytes", input.self.memoryMaxBytes),
        metric("memory.ceiling_hits", "Memory ceiling hits", "events", input.self.ceilingHits),
        metric("memory.socket_throttles", "Socket allocation throttles", "events", input.self.socketThrottles),
      ],
    },
    ...input.health.components.map(
      (component): ObservationResource => ({
        id: `dependency:${component.component}`,
        name: component.component,
        kind: "dependency",
        health: mapHealth(component.status),
        metrics: [],
      }),
    ),
  ];
  return {
    schema_version: SCHEMA_VERSION,
    observed_at: input.observedAt.toISOString(),
    resources,
    cost_estimate: costEstimate(input.runRate, input.unpriced),
  };
}

/**
 * A container hitting its memory ceiling, or taking socket throttles, is
 * degraded even though it is still serving: the kernel is stalling it and
 * refusing its allocations.
 *
 * Judged on whichever counters this kernel actually exposes, not on all of
 * them. `sock_throttled` is not in every kernel's memory.events -- the
 * deployed control plane runs on a 6.1 guest that has `max` but not
 * `sock_throttled`, while the 7.0 host has both. Requiring both meant that
 * container reported `unknown` forever while sitting on a perfectly good
 * `ceiling_hits` of 0, throwing away the primary signal because a secondary
 * one was missing. `unknown` now means what it says: nothing was readable.
 *
 * Deliberately not defaulting a missing counter to 0. Absent is not zero --
 * zero is the healthy reading, and pretending an unreadable counter is healthy
 * is the exact failure this resource exists to expose.
 */
function containerHealth(self: ObservationInput["self"]): ResourceHealth {
  const readable = [self.ceilingHits, self.socketThrottles].filter(
    (counter): counter is number => counter !== undefined,
  );
  if (readable.length === 0) return "unknown";
  return readable.some((counter) => counter > 0) ? "degraded" : "healthy";
}
