// SPDX-License-Identifier: AGPL-3.0-or-later
import { isoTimestamp, type IsoTimestamp } from "../domain/ids";

import type { AuditEvent } from "./audit";

/**
 * Cost model: pure functions that turn the first-class lifecycle audit log into
 * money. The log is the authoritative ledger of *when* each workspace was
 * running vs. scaled-to-zero (every transition is recorded by
 * `WorkspaceService`); these functions reconstruct those intervals and price
 * them. No I/O, no clock — the caller supplies `now`, the pricing, and each
 * workspace's persisted sizing.
 *
 * Cost has three components, matching how the platform actually bills on AWS:
 *  - **compute** — Fargate vCPU + memory, billed only while a task runs;
 *  - **volume** — the live EBS gp3 volume, present while running AND through
 *    teardown until the task is stopped (scale-to-zero snapshots then *releases*
 *    it — see `AGENTS.md` §1);
 *  - **snapshot** — EBS snapshot storage, the unit of persistence that holds a
 *    scaled-to-zero workspace, billed while it is stopped AND through teardown.
 *
 * A workspace's lifecycle has a fourth billable phase, **teardown**: the window
 * between the delete *request* (`session.delete`) and teardown *completion*
 * (`session.terminated`, emitted by `finishDeleting` once the task is stopped and
 * the record removed). The EBS volume and its data-safety snapshot keep costing
 * real money through that window, so it bills volume + snapshot (no compute) —
 * otherwise teardown lag would be silently free (an under-count).
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
/** Audit action for the delete *request* — compute stops, but the volume + snapshot
 * keep billing through the teardown window (it opens the `teardown` phase). */
const TEARDOWN_START_ACTION = "session.delete";
/** Audit action for teardown *completion* (finishDeleting stopped the task and
 * removed the record) — ends all billing. */
const TERMINATE_ACTION = "session.terminated";

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
  /** Windows between the delete request and teardown completion — the volume +
   * snapshot still exist and bill (no compute). */
  readonly teardown: readonly Interval[];
  /** True once the workspace finished teardown — no interval is left open to `now`. */
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
  /** Teardown-window ms (delete request → termination); bills volume + snapshot. */
  readonly teardownMs: number;
}

/** One workspace's events plus the attribution the shell resolved (owner +
 * current lifecycle state, if the record still exists). */
export interface WorkspaceCostInput {
  readonly workspaceId: string;
  /** Display identity the cost is attributed to (email or id). */
  readonly owner: string;
  /** The persisted resources this workspace/session was provisioned with. */
  readonly sizing: WorkspaceSizing;
  /** Current lifecycle state, when the workspace record still exists. */
  readonly state?: string;
  readonly events: readonly AuditEvent[];
}

/** Per-session (per-workspace) cost line in the report. */
export interface SessionCost extends CostBreakdown {
  readonly workspaceId: string;
  readonly owner: string;
  readonly sizing: WorkspaceSizing;
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
  // Sort by parsed instant (not string compare): equivalent ISO timestamps in
  // different formats (`Z` vs `+00:00`, `.000` vs none) must order chronologically,
  // or a later event could sort before an earlier one and clamp an interval to zero,
  // silently losing billable time. Drop unparseable timestamps up front.
  const sorted = [...events]
    .filter((e) => !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const running: Interval[] = [];
  const stopped: Interval[] = [];
  const teardown: Interval[] = [];
  let phase: "none" | "running" | "stopped" | "teardown" = "none";
  let openSince = 0;
  let terminated = false;

  const bucketFor = (p: typeof phase): Interval[] | null =>
    p === "running" ? running : p === "stopped" ? stopped : p === "teardown" ? teardown : null;
  const closeOpen = (toMs: number): void => {
    const bucket = bucketFor(phase);
    if (bucket !== null) bucket.push({ fromMs: openSince, toMs: Math.max(openSince, toMs) });
  };

  for (const event of sorted) {
    if (terminated) break;
    const atMs = Date.parse(event.at);
    if (Number.isNaN(atMs)) continue;
    if (RUNNING_START_ACTIONS.has(event.action)) {
      // A start during teardown is impossible (a deleting workspace can't wake), so
      // only re-open from none/stopped — never reverse a committed teardown.
      if (phase === "stopped") closeOpen(atMs);
      if (phase === "none" || phase === "stopped") {
        phase = "running";
        openSince = atMs;
      }
    } else if (event.action === STOP_ACTION) {
      if (phase === "running") {
        closeOpen(atMs);
        phase = "stopped";
        openSince = atMs;
      }
    } else if (event.action === TEARDOWN_START_ACTION) {
      if (phase === "running" || phase === "stopped") {
        closeOpen(atMs);
        phase = "teardown";
        openSince = atMs;
      }
    } else if (event.action === TERMINATE_ACTION) {
      closeOpen(atMs);
      terminated = true;
      phase = "none";
    }
  }

  if (!terminated) closeOpen(nowMs);
  return { running, stopped, teardown, terminated };
}

function totalMs(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.toMs - i.fromMs), 0);
}

function assertFiniteNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number, got ${String(value)}`);
  }
}

function assertFinitePositive(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number, got ${String(value)}`);
  }
}

function assertPricing(pricing: Pricing): void {
  assertFiniteNonNegative("pricing.fargateVcpuHourUsd", pricing.fargateVcpuHourUsd);
  assertFiniteNonNegative("pricing.fargateGbHourUsd", pricing.fargateGbHourUsd);
  assertFiniteNonNegative("pricing.ebsGbMonthUsd", pricing.ebsGbMonthUsd);
  assertFiniteNonNegative("pricing.snapshotGbMonthUsd", pricing.snapshotGbMonthUsd);
}

function assertSizing(sizing: WorkspaceSizing): void {
  assertFinitePositive("sizing.vcpu", sizing.vcpu);
  assertFinitePositive("sizing.memoryGib", sizing.memoryGib);
  assertFinitePositive("sizing.volumeGib", sizing.volumeGib);
}

function assertBreakdown(label: string, cost: CostBreakdown): void {
  assertFiniteNonNegative(`${label}.computeUsd`, cost.computeUsd);
  assertFiniteNonNegative(`${label}.volumeUsd`, cost.volumeUsd);
  assertFiniteNonNegative(`${label}.snapshotUsd`, cost.snapshotUsd);
  assertFiniteNonNegative(`${label}.totalUsd`, cost.totalUsd);
  assertFiniteNonNegative(`${label}.runningMs`, cost.runningMs);
  assertFiniteNonNegative(`${label}.stoppedMs`, cost.stoppedMs);
  assertFiniteNonNegative(`${label}.teardownMs`, cost.teardownMs);
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
    teardown: clip(intervals.teardown),
    terminated: intervals.terminated,
  };
}

/** Pure: the now-relative report window `[now - days, now)` in epoch ms. Fails loud
 * on a non-positive / non-finite `days` rather than returning an inverted or empty
 * window that would silently zero every session out of the report (§6.5) — a windowed
 * report of $0 must mean "no activity", never "bad window". */
export function relativeWindow(now: IsoTimestamp, days: number): Interval {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`relativeWindow: days must be a positive finite number, got ${String(days)}`);
  }
  const nowMs = Date.parse(now);
  return { fromMs: nowMs - days * MS_PER_DAY, toMs: nowMs };
}

/** Pure: price reconstructed intervals for one workspace at the given rates/sizing. */
export function priceIntervals(
  intervals: BillingIntervals,
  pricing: Pricing,
  sizing: WorkspaceSizing,
): CostBreakdown {
  return priceDurations(
    totalMs(intervals.running),
    totalMs(intervals.stopped),
    totalMs(intervals.teardown),
    pricing,
    sizing,
  );
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
  teardownMs: number,
  pricing: Pricing,
  sizing: WorkspaceSizing,
): CostBreakdown {
  assertFiniteNonNegative("runningMs", runningMs);
  assertFiniteNonNegative("stoppedMs", stoppedMs);
  assertFiniteNonNegative("teardownMs", teardownMs);
  assertPricing(pricing);
  assertSizing(sizing);
  const runningHours = runningMs / MS_PER_HOUR;
  const computeUsd =
    runningHours *
    (sizing.vcpu * pricing.fargateVcpuHourUsd + sizing.memoryGib * pricing.fargateGbHourUsd);
  // The live EBS volume bills while running AND through teardown (until the task is
  // stopped); the snapshot bills while stopped AND through teardown (the data-safety
  // snapshot exists). Teardown therefore accrues both, but no compute.
  const volumeUsd =
    ((runningMs + teardownMs) / MS_PER_MONTH) * sizing.volumeGib * pricing.ebsGbMonthUsd;
  const snapshotUsd =
    ((stoppedMs + teardownMs) / MS_PER_MONTH) * sizing.volumeGib * pricing.snapshotGbMonthUsd;
  const cost = {
    computeUsd,
    volumeUsd,
    snapshotUsd,
    totalUsd: computeUsd + volumeUsd + snapshotUsd,
    runningMs,
    stoppedMs,
    teardownMs,
  };
  assertBreakdown("cost", cost);
  return cost;
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
  readonly teardownMs: number;
  readonly phase: "running" | "stopped" | "teardown" | "none" | "terminated";
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
    phase: "running" | "stopped" | "teardown" | "none";
    openSince: number;
    runningMs: number;
    stoppedMs: number;
    teardownMs: number;
  },
): {
  phase: "running" | "stopped" | "teardown" | "none";
  openSince: number;
  runningMs: number;
  stoppedMs: number;
  teardownMs: number;
  terminated: boolean;
} {
  let { phase, openSince, runningMs, stoppedMs, teardownMs } = init;
  let terminated = false;
  const add = (toMs: number): void => {
    const d = Math.max(0, toMs - openSince);
    if (phase === "running") runningMs += d;
    else if (phase === "stopped") stoppedMs += d;
    else if (phase === "teardown") teardownMs += d;
  };
  const sorted = [...events]
    .filter((e) => {
      const m = Date.parse(e.at);
      return !Number.isNaN(m) && m > afterMs && m <= throughMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    if (terminated) break;
    const atMs = Date.parse(event.at);
    if (RUNNING_START_ACTIONS.has(event.action)) {
      if (phase === "none" || phase === "stopped") {
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
    } else if (event.action === TEARDOWN_START_ACTION) {
      if (phase === "running" || phase === "stopped") {
        add(atMs);
        phase = "teardown";
        openSince = atMs;
      }
    } else if (event.action === TERMINATE_ACTION) {
      add(atMs);
      terminated = true;
      phase = "none";
    }
  }
  return { phase, openSince, runningMs, stoppedMs, teardownMs, terminated };
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
    teardownMs: 0,
  });
  // Close the still-open interval at the checkpoint (fold through-checkpoint time
  // in); the phase is retained so the resume re-opens from here.
  let { runningMs, stoppedMs, teardownMs } = w;
  if (!w.terminated) {
    const d = Math.max(0, cutMs - w.openSince);
    if (w.phase === "running") runningMs += d;
    else if (w.phase === "stopped") stoppedMs += d;
    else if (w.phase === "teardown") teardownMs += d;
  }
  return { runningMs, stoppedMs, teardownMs, phase: w.terminated ? "terminated" : w.phase };
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
): { runningMs: number; stoppedMs: number; teardownMs: number; terminated: boolean } {
  if (state.phase === "terminated") {
    return {
      runningMs: state.runningMs,
      stoppedMs: state.stoppedMs,
      teardownMs: state.teardownMs,
      terminated: true,
    };
  }
  const cutMs = Date.parse(checkpointAt);
  const nowMs = Date.parse(now);
  const w = walkBilling(eventsAfter, cutMs, nowMs, {
    phase: state.phase,
    openSince: cutMs,
    runningMs: state.runningMs,
    stoppedMs: state.stoppedMs,
    teardownMs: state.teardownMs,
  });
  let { runningMs, stoppedMs, teardownMs } = w;
  if (!w.terminated) {
    const d = Math.max(0, nowMs - w.openSince);
    if (w.phase === "running") runningMs += d;
    else if (w.phase === "stopped") stoppedMs += d;
    else if (w.phase === "teardown") teardownMs += d;
  }
  return { runningMs, stoppedMs, teardownMs, terminated: w.terminated };
}

function addBreakdowns(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    computeUsd: a.computeUsd + b.computeUsd,
    volumeUsd: a.volumeUsd + b.volumeUsd,
    snapshotUsd: a.snapshotUsd + b.snapshotUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    runningMs: a.runningMs + b.runningMs,
    stoppedMs: a.stoppedMs + b.stoppedMs,
    teardownMs: a.teardownMs + b.teardownMs,
  };
}

const ZERO_COST: CostBreakdown = {
  computeUsd: 0,
  volumeUsd: 0,
  snapshotUsd: 0,
  totalUsd: 0,
  runningMs: 0,
  stoppedMs: 0,
  teardownMs: 0,
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
  now: IsoTimestamp,
  window?: Interval,
): FleetCostReport {
  const bySession: SessionCost[] = [];
  for (const w of inputs) {
    // State/terminated describe the session's lifecycle (independent of the
    // window), so derive them from the full intervals; price the clipped ones.
    const lifetime = deriveBillingIntervals(w.events, now);
    const intervals = window ? clipIntervals(lifetime, window) : lifetime;
    const cost = priceIntervals(intervals, pricing, w.sizing);
    // In a windowed view, omit sessions with no billable time inside the window.
    if (window && cost.runningMs + cost.stoppedMs + cost.teardownMs === 0) continue;
    bySession.push({
      workspaceId: w.workspaceId,
      owner: w.owner,
      sizing: w.sizing,
      state: w.state ?? (lifetime.terminated ? "terminated" : "unknown"),
      terminated: lifetime.terminated,
      ...cost,
    });
  }

  const windowStart = window
    ? isoTimestamp(new Date(window.fromMs).toISOString())
    : earliestEventAt(inputs, now);
  return aggregateFleetCost(bySession, pricing, now, windowStart);
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
    assertBreakdown(`session ${s.workspaceId}`, s);
    assertSizing(s.sizing);
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
    total,
    byUser,
    bySession: sortedSessions,
  };
}

/** The earliest audit-event timestamp across all workspaces (the ledger start),
 * or `now` when there are no events. */
function earliestEventAt(inputs: readonly WorkspaceCostInput[], now: IsoTimestamp): IsoTimestamp {
  // Compare by parsed INSTANT, not string: a single event in a non-`Z` ISO surface
  // form must still register as earlier when it truly is (mixing this would clip the
  // ledger window and silently zero billable time) — the same guard walkBilling uses.
  let earliest: IsoTimestamp = now;
  let earliestMs = Date.parse(now);
  for (const w of inputs) {
    for (const e of w.events) {
      const ms = Date.parse(e.at);
      if (Number.isFinite(ms) && ms < earliestMs) {
        earliest = e.at;
        earliestMs = ms;
      }
    }
  }
  return earliest;
}
