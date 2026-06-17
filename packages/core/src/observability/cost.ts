// SPDX-License-Identifier: AGPL-3.0-or-later
import { isoTimestamp, type IsoTimestamp } from "../domain/ids";

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
/** Milliseconds in one day (for now-relative report windows). */
const MS_PER_DAY = 24 * MS_PER_HOUR;
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

/** Intersect one interval with `[fromMs, toMs)`; `null` when they do not overlap. */
function clipInterval(i: Interval, fromMs: number, toMs: number): Interval | null {
  const from = Math.max(i.fromMs, fromMs);
  const to = Math.min(i.toMs, toMs);
  return to > from ? { fromMs: from, toMs: to } : null;
}

/**
 * Pure: clip a workspace's billing intervals to a `[fromMs, toMs)` window — keep
 * only the part of each running/stopped interval that falls inside it. Pricing is
 * linear in the durations, so a windowed report is just the lifetime intervals
 * clipped to the window and priced. `terminated` is unchanged: it describes the
 * session's lifecycle, not the window.
 */
export function clipIntervals(intervals: BillingIntervals, window: Interval): BillingIntervals {
  const clip = (xs: readonly Interval[]): Interval[] =>
    xs
      .map((i) => clipInterval(i, window.fromMs, window.toMs))
      .filter((i): i is Interval => i !== null);
  return {
    running: clip(intervals.running),
    stopped: clip(intervals.stopped),
    terminated: intervals.terminated,
  };
}

/** Pure: the now-relative report window `[now - days, now)` in epoch ms. */
export function relativeWindow(now: IsoTimestamp, days: number): Interval {
  const nowMs = Date.parse(now);
  return { fromMs: nowMs - days * MS_PER_DAY, toMs: nowMs };
}

/** Pure: price reconstructed intervals for one workspace at the given rates/sizing. */
export function priceIntervals(
  intervals: BillingIntervals,
  pricing: Pricing,
  sizing: WorkspaceSizing,
): CostBreakdown {
  return priceDurations(totalMs(intervals.running), totalMs(intervals.stopped), pricing, sizing);
}

/**
 * Pure: price total running/stopped durations directly (the cost is linear in the
 * totals — interval boundaries don't matter). Lets the cost rollup price from a
 * resumed {@link BillingState} without rebuilding interval arrays, identically to
 * {@link priceIntervals}.
 */
export function priceDurations(
  runningMs: number,
  stoppedMs: number,
  pricing: Pricing,
  sizing: WorkspaceSizing,
): CostBreakdown {
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

/**
 * A workspace's accumulated billing state at a checkpoint instant: the running /
 * stopped durations through `checkpointAt` (any interval open at the checkpoint is
 * folded in, closed at the checkpoint) plus the open phase there. A cost rollup
 * persists this so a later report can **resume** pricing from the checkpoint —
 * replaying only the events since it — instead of re-deriving the whole ledger.
 */
export interface BillingState {
  readonly runningMs: number;
  readonly stoppedMs: number;
  readonly phase: "running" | "stopped" | "none" | "terminated";
}

/** The lifecycle transition walk, shared by the checkpoint helpers so they price
 * identically to {@link deriveBillingIntervals}. Accumulates closed running/stopped
 * durations from an initial `phase`/`openSince`, over events in `(after, through]`,
 * and returns the carry state. Does not close the final open interval — the caller
 * decides where to close it (at the checkpoint, or at `now`). */
function walkBilling(
  events: readonly AuditEvent[],
  afterMs: number,
  throughMs: number,
  init: {
    phase: "running" | "stopped" | "none";
    openSince: number;
    runningMs: number;
    stoppedMs: number;
  },
): {
  phase: "running" | "stopped" | "none";
  openSince: number;
  runningMs: number;
  stoppedMs: number;
  terminated: boolean;
} {
  let { phase, openSince, runningMs, stoppedMs } = init;
  let terminated = false;
  const add = (toMs: number): void => {
    const d = Math.max(0, toMs - openSince);
    if (phase === "running") runningMs += d;
    else if (phase === "stopped") stoppedMs += d;
  };
  const sorted = [...events]
    .filter((e) => {
      const m = Date.parse(e.at);
      return !Number.isNaN(m) && m > afterMs && m <= throughMs;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const event of sorted) {
    if (terminated) break;
    const atMs = Date.parse(event.at);
    if (RUNNING_START_ACTIONS.has(event.action)) {
      if (phase !== "running") {
        add(atMs);
        phase = "running";
        openSince = atMs;
      }
    } else if (event.action === STOP_ACTION) {
      if (phase === "running") {
        add(atMs);
        phase = "stopped";
        openSince = atMs;
      }
    } else if (event.action === TERMINATE_ACTION) {
      add(atMs);
      terminated = true;
      phase = "none";
    }
  }
  return { phase, openSince, runningMs, stoppedMs, terminated };
}

/**
 * Pure: a workspace's {@link BillingState} as of `checkpointAt` — the same
 * transition semantics as {@link deriveBillingIntervals}, but the interval open at
 * the checkpoint is closed there and folded into the totals, and the open phase is
 * reported so {@link resumeBilling} can continue it. Events after `checkpointAt`
 * are ignored (they belong to the resume).
 */
export function deriveBillingState(
  events: readonly AuditEvent[],
  checkpointAt: IsoTimestamp,
): BillingState {
  const cutMs = Date.parse(checkpointAt);
  const w = walkBilling(events, Number.NEGATIVE_INFINITY, cutMs, {
    phase: "none",
    openSince: 0,
    runningMs: 0,
    stoppedMs: 0,
  });
  // Close the still-open interval at the checkpoint (fold through-checkpoint time
  // in); the phase is retained so the resume re-opens from here.
  let { runningMs, stoppedMs } = w;
  if (!w.terminated && w.phase === "running") runningMs += Math.max(0, cutMs - w.openSince);
  else if (!w.terminated && w.phase === "stopped") stoppedMs += Math.max(0, cutMs - w.openSince);
  return { runningMs, stoppedMs, phase: w.terminated ? "terminated" : w.phase };
}

/**
 * Pure: resume pricing from a checkpoint {@link BillingState} — replay only the
 * events after `checkpointAt`, re-opening the checkpoint's phase from there, and
 * close the final open interval at `now` (unless terminated). Returns the TOTAL
 * running/stopped ms (checkpoint + since). Combined with `deriveBillingState`, this
 * is exactly what `deriveBillingIntervals` would compute over the whole ledger —
 * the invariant the rollup relies on (and the figure-equivalence test asserts).
 */
export function resumeBilling(
  state: BillingState,
  checkpointAt: IsoTimestamp,
  eventsAfter: readonly AuditEvent[],
  now: IsoTimestamp,
): { runningMs: number; stoppedMs: number; terminated: boolean } {
  if (state.phase === "terminated") {
    return { runningMs: state.runningMs, stoppedMs: state.stoppedMs, terminated: true };
  }
  const cutMs = Date.parse(checkpointAt);
  const nowMs = Date.parse(now);
  const w = walkBilling(eventsAfter, cutMs, nowMs, {
    phase: state.phase,
    openSince: cutMs,
    runningMs: state.runningMs,
    stoppedMs: state.stoppedMs,
  });
  let { runningMs, stoppedMs } = w;
  if (!w.terminated && w.phase === "running") runningMs += Math.max(0, nowMs - w.openSince);
  else if (!w.terminated && w.phase === "stopped") stoppedMs += Math.max(0, nowMs - w.openSince);
  return { runningMs, stoppedMs, terminated: w.terminated };
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
 * fleet total — from each workspace's lifecycle events. Without `window` this is
 * the lifetime cost (the whole ledger the caller supplies). With `window`, each
 * session is priced over only the part of its run-time inside `[from, to)`, and
 * sessions with no activity in the window are dropped. Sessions and users are
 * returned most-expensive first.
 */
export function computeFleetCost(
  inputs: readonly WorkspaceCostInput[],
  pricing: Pricing,
  sizing: WorkspaceSizing,
  now: IsoTimestamp,
  window?: Interval,
): FleetCostReport {
  const bySession: SessionCost[] = [];
  for (const w of inputs) {
    // State/terminated describe the session's lifecycle (independent of the
    // window), so derive them from the full intervals; price the clipped ones.
    const lifetime = deriveBillingIntervals(w.events, now);
    const intervals = window ? clipIntervals(lifetime, window) : lifetime;
    const cost = priceIntervals(intervals, pricing, sizing);
    // In a windowed view, omit sessions with no run-time inside the window.
    if (window && cost.runningMs + cost.stoppedMs === 0) continue;
    bySession.push({
      workspaceId: w.workspaceId,
      owner: w.owner,
      state: w.state ?? (lifetime.terminated ? "terminated" : "unknown"),
      terminated: lifetime.terminated,
      ...cost,
    });
  }

  const windowStart = window
    ? isoTimestamp(new Date(window.fromMs).toISOString())
    : earliestEventAt(inputs, now);
  return aggregateFleetCost(bySession, pricing, sizing, now, windowStart);
}

/**
 * Pure: roll a per-session cost list up into the fleet report (per-user totals,
 * fleet total, both most-expensive first). Shared by the full-ledger
 * {@link computeFleetCost} and the cost-rollup report path so the two produce
 * byte-identical figures — the invariant the figure-equivalence test guards.
 */
export function aggregateFleetCost(
  bySession: readonly SessionCost[],
  pricing: Pricing,
  sizing: WorkspaceSizing,
  generatedAt: IsoTimestamp,
  windowStart: IsoTimestamp,
): FleetCostReport {
  // Sum in a canonical (workspaceId) order first: float addition is not
  // associative, so the full-scan and rollup paths — which build the session list
  // in different orders — must fold in the same order to produce byte-identical
  // totals. Display order (most-expensive first) is applied afterwards.
  const canonical = [...bySession].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  const byUserMap = new Map<string, { cost: CostBreakdown; sessions: number }>();
  for (const s of canonical) {
    const entry = byUserMap.get(s.owner) ?? { cost: ZERO_COST, sessions: 0 };
    byUserMap.set(s.owner, { cost: addBreakdowns(entry.cost, s), sessions: entry.sessions + 1 });
  }
  const byUser: UserCost[] = [...byUserMap.entries()].map(([owner, { cost, sessions }]) => ({
    owner,
    sessions,
    ...cost,
  }));
  const total = canonical.reduce<CostBreakdown>((sum, s) => addBreakdowns(sum, s), ZERO_COST);
  const sortedSessions = canonical.sort((a, b) => b.totalUsd - a.totalUsd);
  byUser.sort((a, b) => b.totalUsd - a.totalUsd);
  return {
    generatedAt,
    windowStart,
    pricing,
    sizing,
    total,
    byUser,
    bySession: sortedSessions,
  };
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
