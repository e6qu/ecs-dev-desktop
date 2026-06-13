// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IsoTimestamp } from "../domain/ids";

import type { AuditEvent } from "./audit";

/**
 * Cost model: pure functions that turn the first-class lifecycle audit log into
 * money. The log is the authoritative ledger of *when* each workspace was
 * running vs. scaled-to-zero (every transition is recorded by
 * `WorkspaceService`); these functions reconstruct those intervals and price
 * them. No I/O, no clock — the caller supplies `now` and the pricing/sizing.
 *
 * Cost has three components, matching how the platform actually bills on AWS:
 *  - **compute** — Fargate vCPU + memory, billed only while a task runs;
 *  - **volume** — the live EBS gp3 volume, present only while running
 *    (scale-to-zero snapshots then *releases* it — see `AGENTS.md` §1);
 *  - **snapshot** — EBS snapshot storage, the unit of persistence that holds a
 *    scaled-to-zero workspace, billed while it is stopped.
 */

/** Milliseconds in one hour. */
const MS_PER_HOUR = 60 * 60 * 1000;
/**
 * Hours AWS bills per "month" for per-GB-month resources (EBS volumes and
 * snapshots): a flat 730 (AWS's documented convention), independent of calendar
 * month length. Source: AWS EBS pricing FAQ ("we charge per GB-month … 730
 * hours").
 */
const HOURS_PER_MONTH = 730;
const MS_PER_MONTH = HOURS_PER_MONTH * MS_PER_HOUR;

/** Audit actions that put a workspace into a billable (running) state. */
const RUNNING_START_ACTIONS: ReadonlySet<string> = new Set(["session.create", "session.start"]);
/** Audit action that scales a workspace to zero (running → stopped/snapshot). */
const STOP_ACTION = "session.stop";
/** Audit action that terminates a workspace (ends all billing). */
const TERMINATE_ACTION = "session.delete";

/**
 * Per-hour / per-month USD rates the cost model applies. Every rate is supplied
 * by config (us-east-1 on-demand defaults live in `@edd/config`, env-overridable)
 * — nothing is hardcoded here, so the same code prices the sim and real cloud.
 */
export interface Pricing {
  /** Fargate vCPU, USD per vCPU-hour. */
  readonly fargateVcpuHourUsd: number;
  /** Fargate memory, USD per GB-hour. */
  readonly fargateGbHourUsd: number;
  /** Live EBS gp3 volume, USD per GB-month. */
  readonly ebsGbMonthUsd: number;
  /** EBS snapshot storage, USD per GB-month. */
  readonly snapshotGbMonthUsd: number;
}

/** Per-workspace resource sizing the cost model multiplies by run-time. */
export interface WorkspaceSizing {
  /** vCPUs the task is allocated (e.g. 0.5 for 512 ECS CPU units). */
  readonly vcpu: number;
  /** Memory the task is allocated, in GiB. */
  readonly memoryGib: number;
  /** EBS volume size, in GiB. */
  readonly volumeGib: number;
}

/** A half-open time interval `[fromMs, toMs)` in epoch milliseconds. */
export interface Interval {
  readonly fromMs: number;
  readonly toMs: number;
}

/** A workspace's reconstructed billing intervals, split by what is billable. */
export interface BillingIntervals {
  /** Windows the workspace held a live task + volume (compute + volume cost). */
  readonly running: readonly Interval[];
  /** Windows the workspace was scaled to zero, held by a snapshot (snapshot cost). */
  readonly stopped: readonly Interval[];
  /** True once the workspace was deleted — no interval is left open to `now`. */
  readonly terminated: boolean;
}

/** A priced cost breakdown (USD) plus the durations it was derived from. */
export interface CostBreakdown {
  readonly computeUsd: number;
  readonly volumeUsd: number;
  readonly snapshotUsd: number;
  readonly totalUsd: number;
  readonly runningMs: number;
  readonly stoppedMs: number;
}

/** One workspace's events plus the attribution the shell resolved (owner +
 * current lifecycle state, if the record still exists). */
export interface WorkspaceCostInput {
  readonly workspaceId: string;
  /** Display identity the cost is attributed to (email or id). */
  readonly owner: string;
  /** Current lifecycle state, when the workspace record still exists. */
  readonly state?: string;
  readonly events: readonly AuditEvent[];
}

/** Per-session (per-workspace) cost line in the report. */
export interface SessionCost extends CostBreakdown {
  readonly workspaceId: string;
  readonly owner: string;
  readonly state: string;
  readonly terminated: boolean;
}

/** Per-user rollup line in the report. */
export interface UserCost extends CostBreakdown {
  readonly owner: string;
  readonly sessions: number;
}

/** The full fleet cost report (lifetime, derived from the audit ledger). */
export interface FleetCostReport {
  readonly generatedAt: IsoTimestamp;
  /** Earliest event the report drew from (the ledger's start, or `generatedAt`). */
  readonly windowStart: IsoTimestamp;
  readonly pricing: Pricing;
  readonly sizing: WorkspaceSizing;
  readonly total: CostBreakdown;
  readonly byUser: readonly UserCost[];
  readonly bySession: readonly SessionCost[];
}

/**
 * Pure: reconstruct one workspace's running/stopped intervals from its lifecycle
 * audit events. Events are sorted chronologically here, so callers may pass them
 * in any order. A start while already running (e.g. an idempotent reconnect that
 * still logged) is ignored — it does not double-open an interval. Any open
 * interval is closed at `now` unless the workspace was terminated.
 */
export function deriveBillingIntervals(
  events: readonly AuditEvent[],
  now: IsoTimestamp,
): BillingIntervals {
  const nowMs = Date.parse(now);
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const running: Interval[] = [];
  const stopped: Interval[] = [];
  let phase: "none" | "running" | "stopped" = "none";
  let openSince = 0;
  let terminated = false;

  const close = (bucket: Interval[], toMs: number): void => {
    bucket.push({ fromMs: openSince, toMs: Math.max(openSince, toMs) });
  };

  for (const event of sorted) {
    if (terminated) break;
    const atMs = Date.parse(event.at);
    if (Number.isNaN(atMs)) continue;
    if (RUNNING_START_ACTIONS.has(event.action)) {
      if (phase === "stopped") close(stopped, atMs);
      if (phase !== "running") {
        phase = "running";
        openSince = atMs;
      }
    } else if (event.action === STOP_ACTION) {
      if (phase === "running") {
        close(running, atMs);
        phase = "stopped";
        openSince = atMs;
      }
    } else if (event.action === TERMINATE_ACTION) {
      if (phase === "running") close(running, atMs);
      else if (phase === "stopped") close(stopped, atMs);
      terminated = true;
      phase = "none";
    }
  }

  if (!terminated && phase === "running") close(running, nowMs);
  if (!terminated && phase === "stopped") close(stopped, nowMs);
  return { running, stopped, terminated };
}

function totalMs(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.toMs - i.fromMs), 0);
}

/** Pure: price reconstructed intervals for one workspace at the given rates/sizing. */
export function priceIntervals(
  intervals: BillingIntervals,
  pricing: Pricing,
  sizing: WorkspaceSizing,
): CostBreakdown {
  const runningMs = totalMs(intervals.running);
  const stoppedMs = totalMs(intervals.stopped);
  const runningHours = runningMs / MS_PER_HOUR;
  const computeUsd =
    runningHours *
    (sizing.vcpu * pricing.fargateVcpuHourUsd + sizing.memoryGib * pricing.fargateGbHourUsd);
  const volumeUsd = (runningMs / MS_PER_MONTH) * sizing.volumeGib * pricing.ebsGbMonthUsd;
  const snapshotUsd = (stoppedMs / MS_PER_MONTH) * sizing.volumeGib * pricing.snapshotGbMonthUsd;
  return {
    computeUsd,
    volumeUsd,
    snapshotUsd,
    totalUsd: computeUsd + volumeUsd + snapshotUsd,
    runningMs,
    stoppedMs,
  };
}

function addBreakdowns(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    computeUsd: a.computeUsd + b.computeUsd,
    volumeUsd: a.volumeUsd + b.volumeUsd,
    snapshotUsd: a.snapshotUsd + b.snapshotUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    runningMs: a.runningMs + b.runningMs,
    stoppedMs: a.stoppedMs + b.stoppedMs,
  };
}

const ZERO_COST: CostBreakdown = {
  computeUsd: 0,
  volumeUsd: 0,
  snapshotUsd: 0,
  totalUsd: 0,
  runningMs: 0,
  stoppedMs: 0,
};

/**
 * Pure: the full fleet cost report — per session, rolled up per user and to a
 * fleet total — from each workspace's lifecycle events. Lifetime cost (derived
 * from the whole ledger the caller supplies). Sessions and users are returned
 * most-expensive first.
 */
export function computeFleetCost(
  inputs: readonly WorkspaceCostInput[],
  pricing: Pricing,
  sizing: WorkspaceSizing,
  now: IsoTimestamp,
): FleetCostReport {
  const bySession: SessionCost[] = inputs.map((w) => {
    const intervals = deriveBillingIntervals(w.events, now);
    const cost = priceIntervals(intervals, pricing, sizing);
    const state = w.state ?? (intervals.terminated ? "terminated" : "unknown");
    return {
      workspaceId: w.workspaceId,
      owner: w.owner,
      state,
      terminated: intervals.terminated,
      ...cost,
    };
  });

  const byUserMap = new Map<string, { cost: CostBreakdown; sessions: number }>();
  for (const s of bySession) {
    const entry = byUserMap.get(s.owner) ?? { cost: ZERO_COST, sessions: 0 };
    byUserMap.set(s.owner, { cost: addBreakdowns(entry.cost, s), sessions: entry.sessions + 1 });
  }
  const byUser: UserCost[] = [...byUserMap.entries()].map(([owner, { cost, sessions }]) => ({
    owner,
    sessions,
    ...cost,
  }));

  const total = bySession.reduce<CostBreakdown>((sum, s) => addBreakdowns(sum, s), ZERO_COST);
  const windowStart = earliestEventAt(inputs, now);
  bySession.sort((a, b) => b.totalUsd - a.totalUsd);
  byUser.sort((a, b) => b.totalUsd - a.totalUsd);

  return { generatedAt: now, windowStart, pricing, sizing, total, byUser, bySession };
}

/** The earliest audit-event timestamp across all workspaces (the ledger start),
 * or `now` when there are no events. */
function earliestEventAt(inputs: readonly WorkspaceCostInput[], now: IsoTimestamp): IsoTimestamp {
  let earliest: IsoTimestamp = now;
  for (const w of inputs) {
    for (const e of w.events) {
      if (e.at.localeCompare(earliest) < 0) earliest = e.at;
    }
  }
  return earliest;
}
