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
 * the record tombstoned). The EBS volume and its data-safety snapshot keep costing
 * real money through that window, so it bills volume + snapshot (no compute) —
 * otherwise teardown lag would be silently free (an under-count).
 *
 * Teardown completion does NOT end billing: the RETAINED snapshot (the undelete
 * retention window's restore point) keeps accruing snapshot GB-month until the
 * retention purge (`session.purged`) removes it — or `session.undelete` restores
 * the workspace to `stopped`, where the same snapshot simply keeps billing. Both
 * are priced as stopped (snapshot-only) time; only `session.purged` (or a lost
 * retained snapshot) truly ends billing.
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
 * tombstoned the record) — the volume stops billing, but the RETAINED snapshot
 * keeps billing through the undelete-retention window (the `retained` phase). */
const TERMINATE_ACTION = "session.terminated";
/** Audit action restoring a terminated tombstone to `stopped` within the retention
 * window — the retained snapshot keeps billing and the workspace can wake again. */
const UNDELETE_ACTION = "session.undelete";
/** Audit action for the retention purge (tombstone + retained snapshot removed) —
 * the true, permanent end of all billing. */
const PURGE_ACTION = "session.purged";
/** Audit action recording that a workspace's referenced snapshot vanished
 * out-of-band — the snapshot storage is gone, so snapshot billing stops. */
const SNAPSHOT_LOST_ACTION = "session.snapshot_lost";

/** Billing phases with an interval open (accruing) at a walk instant. `retained`
 * is the post-`session.terminated` retention window: the record is a tombstone but
 * its retained snapshot still exists — and bills — until `session.purged` removes
 * it or `session.undelete` restores the workspace to `stopped`. */
type OpenPhase = "none" | "running" | "stopped" | "teardown" | "retained";
/** `terminated` is terminal: the retained snapshot is gone (`session.purged`, or a
 * lost retained snapshot), so nothing bills ever again. */
type WalkPhase = OpenPhase | "terminated";

/**
 * Pure: the lifecycle transition table shared by BOTH walk paths (the full-scan
 * {@link deriveBillingIntervals} and the checkpoint {@link walkBilling}) so their
 * semantics can never diverge. Returns the phase the event moves the workspace
 * into, or `null` when the event does not change the billing phase (idempotent
 * repeats, transitions the lifecycle makes impossible).
 */
function nextPhase(phase: OpenPhase, action: string): WalkPhase | null {
  if (RUNNING_START_ACTIONS.has(action)) {
    // A start during teardown/retention is impossible (a deleting workspace can't
    // wake; a tombstone must be undeleted first) — only open from none/stopped.
    return phase === "none" || phase === "stopped" ? "running" : null;
  }
  switch (action) {
    case STOP_ACTION:
      return phase === "running" ? "stopped" : null;
    case TEARDOWN_START_ACTION:
      return phase === "running" || phase === "stopped" ? "teardown" : null;
    case TERMINATE_ACTION:
      // Teardown completion: the volume is released but the retained snapshot
      // keeps billing through the retention window (idempotent while retained).
      return phase === "retained" ? null : "retained";
    case UNDELETE_ACTION:
      // Restores the tombstone to a stopped workspace held by the same snapshot —
      // snapshot billing continues seamlessly, and the workspace can wake again.
      return phase === "retained" ? "stopped" : null;
    case PURGE_ACTION:
      // Tombstone + retained snapshot removed — the permanent end of all billing.
      return "terminated";
    case SNAPSHOT_LOST_ACTION:
      // The snapshot vanished out-of-band: close the open snapshot-billing phase.
      // From `stopped` the record survives (marked error) with nothing billing; a
      // lost RETAINED snapshot leaves nothing to restore or bill — terminal.
      return phase === "stopped" ? "none" : phase === "retained" ? "terminated" : null;
    default:
      return null;
  }
}

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
  /** Windows only a snapshot billed (snapshot cost): scaled-to-zero time AND the
   * post-teardown retention window (the retained snapshot exists until purged). */
  readonly stopped: readonly Interval[];
  /** Windows between the delete request and teardown completion — the volume +
   * snapshot still exist and bill (no compute). */
  readonly teardown: readonly Interval[];
  /** True when the session's lifecycle stands terminated: tombstoned awaiting the
   * retention purge (its retained snapshot still bills into `stopped`), or purged.
   * A `session.undelete` clears it. */
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
  /** Lifecycle sessions that could not be priced from authoritative attribution. */
  readonly unpriced: readonly CostIssue[];
}

export interface CostIssue {
  readonly workspaceId: string;
  readonly reason: string;
}

/**
 * Pure: reconstruct one workspace's running/stopped intervals from its lifecycle
 * audit events. Events are sorted chronologically here, so callers may pass them
 * in any order. A start while already running (e.g. an idempotent reconnect that
 * still logged) is ignored — it does not double-open an interval. Any open
 * interval is closed at `now` unless billing permanently ended (`session.purged`).
 * Events timestamped AFTER `now` are ignored — the identical clamp `walkBilling`
 * applies (`m <= throughMs`), so writer clock skew can't make the two paths
 * diverge on a future-dated event.
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
    .filter((e) => {
      const m = Date.parse(e.at);
      return !Number.isNaN(m) && m <= nowMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const running: Interval[] = [];
  const stopped: Interval[] = [];
  const teardown: Interval[] = [];
  let phase: WalkPhase = "none";
  let openSince = 0;

  // The retained (retention-window) snapshot bills exactly like a stopped one, so
  // retained windows land in the `stopped` bucket.
  const bucketFor = (p: WalkPhase): Interval[] | null =>
    p === "running"
      ? running
      : p === "stopped" || p === "retained"
        ? stopped
        : p === "teardown"
          ? teardown
          : null;
  const closeOpen = (toMs: number): void => {
    const bucket = bucketFor(phase);
    if (bucket !== null) bucket.push({ fromMs: openSince, toMs: Math.max(openSince, toMs) });
  };

  for (const event of sorted) {
    if (phase === "terminated") break;
    const next = nextPhase(phase, event.action);
    if (next === null) continue;
    const atMs = Date.parse(event.at);
    closeOpen(atMs);
    phase = next;
    openSince = atMs;
  }

  if (phase !== "terminated") closeOpen(nowMs);
  return {
    running,
    stopped,
    teardown,
    terminated: phase === "retained" || phase === "terminated",
  };
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
  /** Snapshot-billed ms: scaled-to-zero AND retention-window (retained) time. */
  readonly stoppedMs: number;
  readonly teardownMs: number;
  readonly phase: WalkPhase;
}

/** Accumulated running/stopped/teardown durations mid-walk. */
interface WalkTotals {
  readonly runningMs: number;
  readonly stoppedMs: number;
  readonly teardownMs: number;
}

/** Pure: `totals` with the interval open in `phase` since `openSince` closed at
 * `toMs` and folded into its bucket (retained bills into `stoppedMs`, exactly as
 * {@link deriveBillingIntervals} buckets retained windows into `stopped`). */
function foldOpen(
  totals: WalkTotals,
  phase: WalkPhase,
  openSince: number,
  toMs: number,
): WalkTotals {
  const d = Math.max(0, toMs - openSince);
  if (phase === "running") return { ...totals, runningMs: totals.runningMs + d };
  if (phase === "stopped" || phase === "retained") {
    return { ...totals, stoppedMs: totals.stoppedMs + d };
  }
  if (phase === "teardown") return { ...totals, teardownMs: totals.teardownMs + d };
  return totals;
}

/** The lifecycle transition walk, shared by the checkpoint helpers so they price
 * identically to {@link deriveBillingIntervals} (both drive {@link nextPhase}).
 * Accumulates closed durations from an initial `phase`/`openSince`, over events in
 * `(after, through]`, and returns the carry state. Does not close the final open
 * interval — the caller decides where to close it (at the checkpoint, or `now`). */
function walkBilling(
  events: readonly AuditEvent[],
  afterMs: number,
  throughMs: number,
  init: WalkTotals & { phase: WalkPhase; openSince: number },
): WalkTotals & { phase: WalkPhase; openSince: number } {
  let { phase, openSince } = init;
  let totals: WalkTotals = init;
  const sorted = [...events]
    .filter((e) => {
      const m = Date.parse(e.at);
      return !Number.isNaN(m) && m > afterMs && m <= throughMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    if (phase === "terminated") break;
    const next = nextPhase(phase, event.action);
    if (next === null) continue;
    const atMs = Date.parse(event.at);
    totals = foldOpen(totals, phase, openSince, atMs);
    phase = next;
    openSince = atMs;
  }
  return { ...totals, phase, openSince };
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
  const totals = foldOpen(w, w.phase, w.openSince, cutMs);
  return { ...totals, phase: w.phase };
}

/**
 * Pure: resume pricing from a checkpoint {@link BillingState} — replay only the
 * events after `checkpointAt`, re-opening the checkpoint's phase from there, and
 * close the final open interval at `now` (unless billing permanently ended).
 * Returns the TOTAL running/stopped ms (checkpoint + since). Combined with
 * `deriveBillingState`, this is exactly what `deriveBillingIntervals` would compute
 * over the whole ledger — the invariant the rollup relies on (and the
 * figure-equivalence tests assert). The returned `terminated` mirrors
 * {@link BillingIntervals.terminated}: the lifecycle stands terminated (retention
 * tombstone or purged), even while the retained snapshot still bills.
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
  const totals = foldOpen(w, w.phase, w.openSince, nowMs);
  return { ...totals, terminated: w.phase === "retained" || w.phase === "terminated" };
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
 * returned most-expensive first. `ledgerStart` lets the caller supply the true
 * ledger start when it knows events `inputs` excludes (e.g. an unpriceable legacy
 * session's) — the default is the earliest event across `inputs`.
 */
export function computeFleetCost(
  inputs: readonly WorkspaceCostInput[],
  pricing: Pricing,
  now: IsoTimestamp,
  window?: Interval,
  unpriced: readonly CostIssue[] = [],
  ledgerStart?: IsoTimestamp,
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
    : (ledgerStart ?? earliestEventAt(inputs, now));
  return aggregateFleetCost(bySession, pricing, now, windowStart, unpriced);
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
  unpriced: readonly CostIssue[] = [],
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
    // Canonical order: the full-scan and rollup paths collect unpriced sessions in
    // different orders — sort so the two reports stay byte-identical.
    unpriced: [...unpriced].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  };
}

/** The control plane's own always-on Fargate footprint, for the run-rate projection.
 * The control plane uses ephemeral task storage (no persistent EBS), so only compute. */
export interface ControlPlaneSizing {
  /** vCPUs per control-plane task (e.g. 0.5 for 512 CPU units). */
  readonly vcpu: number;
  /** Memory per control-plane task, in GiB. */
  readonly memoryGib: number;
  /** Active replica count when the control plane is up (scale-to-zero wakes to this). */
  readonly replicas: number;
}

/** A forward-looking hourly/daily run-rate: what it WOULD cost per hour/day if everything
 * were running at once, split by control plane vs workspaces. On-demand rates, no discounts. */
export interface RunRateProjection {
  /** Every non-terminated workspace running simultaneously (compute + live EBS volume). */
  readonly workspacesUsdPerHour: number;
  /** The control plane at its active replica count (compute only). */
  readonly controlPlaneUsdPerHour: number;
  readonly totalUsdPerHour: number;
  readonly workspacesUsdPerDay: number;
  readonly controlPlaneUsdPerDay: number;
  readonly totalUsdPerDay: number;
}

/** One workspace's hourly cost while RUNNING: Fargate compute + the live EBS volume (the
 * snapshot only bills while stopped, so it's not part of a running-rate). */
function workspaceHourlyUsd(sizing: WorkspaceSizing, pricing: Pricing): number {
  const compute =
    sizing.vcpu * pricing.fargateVcpuHourUsd + sizing.memoryGib * pricing.fargateGbHourUsd;
  const volumePerHour = (sizing.volumeGib * pricing.ebsGbMonthUsd) / HOURS_PER_MONTH;
  return compute + volumePerHour;
}

/**
 * Pure: project the hourly/daily run-rate if EVERYTHING were running at once — every listed
 * workspace plus the control plane at its active replica count — split control-plane vs
 * workspaces. On-demand rates, no discounts (matches the account-bill basis). Callers pass the
 * CURRENT (non-terminated) workspace sizings; a stopped workspace is included because it would
 * cost this if resumed. Daily = hourly × 24.
 */
export function projectRunRate(
  workspaces: readonly WorkspaceSizing[],
  controlPlane: ControlPlaneSizing,
  pricing: Pricing,
): RunRateProjection {
  assertPricing(pricing);
  assertFinitePositive("controlPlane.vcpu", controlPlane.vcpu);
  assertFinitePositive("controlPlane.memoryGib", controlPlane.memoryGib);
  assertFiniteNonNegative("controlPlane.replicas", controlPlane.replicas);
  const workspacesUsdPerHour = workspaces.reduce((sum, s) => {
    assertSizing(s);
    return sum + workspaceHourlyUsd(s, pricing);
  }, 0);
  const controlPlaneUsdPerHour =
    controlPlane.replicas *
    (controlPlane.vcpu * pricing.fargateVcpuHourUsd +
      controlPlane.memoryGib * pricing.fargateGbHourUsd);
  const totalUsdPerHour = workspacesUsdPerHour + controlPlaneUsdPerHour;
  const HOURS_PER_DAY = 24;
  return {
    workspacesUsdPerHour,
    controlPlaneUsdPerHour,
    totalUsdPerHour,
    workspacesUsdPerDay: workspacesUsdPerHour * HOURS_PER_DAY,
    controlPlaneUsdPerDay: controlPlaneUsdPerHour * HOURS_PER_DAY,
    totalUsdPerDay: totalUsdPerHour * HOURS_PER_DAY,
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
