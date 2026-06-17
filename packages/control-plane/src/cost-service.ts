// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import type { CostRollupEntity } from "@edd/db";
import {
  aggregateFleetCost,
  computeFleetCost,
  deriveBillingIntervals,
  deriveBillingState,
  isoTimestamp,
  priceDurations,
  priceIntervals,
  relativeWindow,
  resumeBilling,
  type AuditEvent,
  type BillingState,
  type Clock,
  type FleetCostReport,
  type Interval,
  type IsoTimestamp,
  type Pricing,
  type SessionCost,
  type WorkspaceCostInput,
  type WorkspaceSizing,
} from "@edd/core";

/** Audit-action prefix for billable lifecycle events (session.create/start/…). */
const SESSION_ACTION_PREFIX = "session.";

/** The audit ledger the cost model prices. `all` is the whole ledger (full-scan
 * report + rollup generation); `since` is the time-windowed tail the rollup
 * report replays on top of the checkpoint. */
interface CostAuditSource {
  all(): Promise<AuditEvent[]>;
  since(fromExclusive: string): Promise<AuditEvent[]>;
}

/** The workspace catalog the cost model attributes owners/state from. */
interface CostWorkspaceSource {
  list(): Promise<WorkspaceDto[]>;
}

/** One persisted per-workspace cost checkpoint (see `@edd/db` costRollup). */
export interface CostRollupRecord {
  readonly workspaceId: string;
  readonly owner: string;
  readonly checkpointAt: string;
  readonly windowStart: string;
  readonly runningMs: number;
  readonly stoppedMs: number;
  readonly phase: string;
}

/** Store for the cost checkpoints. `replaceAll` swaps the whole generation
 * atomically-enough for the report (a stale read just prices a slightly older
 * checkpoint + more tail events — still exact). */
export interface CostRollupStore {
  list(): Promise<CostRollupRecord[]>;
  replaceAll(records: readonly CostRollupRecord[]): Promise<void>;
}

export interface CostServiceDeps {
  audit: CostAuditSource;
  workspaces: CostWorkspaceSource;
  clock: Clock;
  pricing: Pricing;
  sizing: WorkspaceSizing;
  /** Optional cost-checkpoint store. When present and populated, `report` prices
   * from the checkpoints + the tail since them (O(recent) instead of O(history));
   * `rollup` regenerates them. Absent/empty → the exact full-ledger scan. */
  rollups?: CostRollupStore;
}

/** Group billable (session.*) events by workspace; non-lifecycle actions form no
 * session and are excluded. */
function groupSessions(events: readonly AuditEvent[]): Map<string, AuditEvent[]> {
  const byWorkspace = new Map<string, AuditEvent[]>();
  for (const e of events) {
    if (!e.action.startsWith(SESSION_ACTION_PREFIX)) continue;
    const list = byWorkspace.get(e.target) ?? [];
    list.push(e);
    byWorkspace.set(e.target, list);
  }
  return byWorkspace;
}

/** Owner attribution: the creator on session.create (carries the email when
 * known), else the current record's owner id, else unknown. */
function ownerOf(events: readonly AuditEvent[], record: WorkspaceDto | undefined): string {
  const created = events.find((e) => e.action === "session.create");
  return created?.actor ?? record?.ownerId ?? "unknown";
}

/** Earliest event timestamp across the ledger (the window start), or `now`. */
function earliestAt(events: readonly AuditEvent[], now: string): string {
  let earliest = now;
  for (const e of events) if (e.at.localeCompare(earliest) < 0) earliest = e.at;
  return earliest;
}

const PHASES = new Set(["running", "stopped", "none", "terminated"]);
function asPhase(value: string): BillingState["phase"] {
  return PHASES.has(value) ? (value as BillingState["phase"]) : "none";
}

/**
 * Imperative shell over the pure cost core. Two report paths, identical figures:
 *  - **full scan** (default / no checkpoints): prices the whole audit ledger;
 *  - **rollup** (`rollups` populated): prices each workspace by resuming from its
 *    persisted checkpoint and replaying only the events since it — O(recent), not
 *    O(history). `rollup()` regenerates the checkpoints (a periodic job).
 * The figure-equivalence integ proves the two produce byte-identical reports.
 */
export class CostService {
  constructor(private readonly deps: CostServiceDeps) {}

  /**
   * The fleet cost report. With `windowDays` it covers only the last N days
   * (each session priced over its in-window run-time); without it, the full
   * lifetime. A windowed report always full-scans: the cost rollup is a single
   * checkpoint→now accumulation that cannot be clamped to an arbitrary window,
   * so it accelerates only the lifetime report.
   */
  async report(windowDays?: number | null): Promise<FleetCostReport> {
    const now = this.now();
    if (windowDays != null) return this.fullScanReport(now, relativeWindow(now, windowDays));
    const rollups = this.deps.rollups ? await this.deps.rollups.list() : [];
    return rollups.length === 0 ? this.fullScanReport(now) : this.rollupReport(rollups, now);
  }

  /** Regenerate the per-workspace cost checkpoints as of now (the periodic job).
   * Prices the whole ledger once here so `report` doesn't have to per request. */
  async rollup(): Promise<void> {
    if (this.deps.rollups === undefined) return;
    const now = this.now();
    const [events, workspaces] = await Promise.all([
      this.deps.audit.all(),
      this.deps.workspaces.list(),
    ]);
    const byWorkspace = groupSessions(events);
    const records = new Map(workspaces.map((w) => [w.id, w]));
    const ids = new Set<string>([...byWorkspace.keys(), ...records.keys()]);
    const windowStart = earliestAt(events, now);
    const out: CostRollupRecord[] = [...ids].map((id) => {
      const wsEvents = byWorkspace.get(id) ?? [];
      const state = deriveBillingState(wsEvents, now);
      return {
        workspaceId: id,
        owner: ownerOf(wsEvents, records.get(id)),
        checkpointAt: now,
        windowStart,
        runningMs: state.runningMs,
        stoppedMs: state.stoppedMs,
        phase: state.phase,
      };
    });
    await this.deps.rollups.replaceAll(out);
  }

  /** The exact full-ledger scan (also the rollup-absent fallback). With `window`
   * each session is priced over only its in-window run-time. */
  private async fullScanReport(now: IsoTimestamp, window?: Interval): Promise<FleetCostReport> {
    const [events, workspaces] = await Promise.all([
      this.deps.audit.all(),
      this.deps.workspaces.list(),
    ]);
    const byWorkspace = groupSessions(events);
    const records = new Map(workspaces.map((w) => [w.id, w]));
    const ids = new Set<string>([...byWorkspace.keys(), ...records.keys()]);
    const inputs: WorkspaceCostInput[] = [...ids].map((id) => {
      const wsEvents = byWorkspace.get(id) ?? [];
      const record = records.get(id);
      return {
        workspaceId: id,
        owner: ownerOf(wsEvents, record),
        ...(record === undefined ? {} : { state: record.state }),
        events: wsEvents,
      };
    });
    return computeFleetCost(inputs, this.deps.pricing, this.deps.sizing, now, window);
  }

  /** Price from the checkpoints + the events since them (O(recent)). Resuming each
   * workspace's checkpoint and replaying only the tail yields the same figures the
   * full scan would (proven by the figure-equivalence integ). */
  private async rollupReport(
    rollups: readonly CostRollupRecord[],
    now: IsoTimestamp,
  ): Promise<FleetCostReport> {
    const checkpoint = isoTimestamp(rollups[0]?.checkpointAt ?? now);
    const windowStart = isoTimestamp(rollups[0]?.windowStart ?? now);
    const [tail, workspaces] = await Promise.all([
      this.deps.audit.since(checkpoint),
      this.deps.workspaces.list(),
    ]);
    const tailByWorkspace = groupSessions(tail);
    const records = new Map(workspaces.map((w) => [w.id, w]));
    const { pricing, sizing } = this.deps;
    const bySession: SessionCost[] = [];
    const rolled = new Set<string>();

    for (const r of rollups) {
      rolled.add(r.workspaceId);
      const tailEvents = tailByWorkspace.get(r.workspaceId) ?? [];
      const state: BillingState = {
        runningMs: r.runningMs,
        stoppedMs: r.stoppedMs,
        phase: asPhase(r.phase),
      };
      const resumed = resumeBilling(state, checkpoint, tailEvents, now);
      const record = records.get(r.workspaceId);
      bySession.push({
        workspaceId: r.workspaceId,
        owner: r.owner,
        state: record?.state ?? (resumed.terminated ? "terminated" : "unknown"),
        terminated: resumed.terminated,
        ...priceDurations(resumed.runningMs, resumed.stoppedMs, pricing, sizing),
      });
    }

    // Workspaces born after the checkpoint: all their events are in the tail.
    for (const [id, tailEvents] of tailByWorkspace) {
      if (rolled.has(id)) continue;
      const intervals = deriveBillingIntervals(tailEvents, now);
      const record = records.get(id);
      bySession.push({
        workspaceId: id,
        owner: ownerOf(tailEvents, record),
        state: record?.state ?? (intervals.terminated ? "terminated" : "unknown"),
        terminated: intervals.terminated,
        ...priceIntervals(intervals, pricing, sizing),
      });
    }

    return aggregateFleetCost(bySession, pricing, sizing, now, windowStart);
  }

  private now() {
    return isoTimestamp(this.deps.clock.now());
  }
}

/** DynamoDB-backed {@link CostRollupStore} over the `costRollup` entity. */
export class StoredCostRollupStore implements CostRollupStore {
  constructor(private readonly entity: CostRollupEntity) {}

  async list(): Promise<CostRollupRecord[]> {
    const { data } = await this.entity.query.byAll({}).go({ pages: "all" });
    return data.map((r) => ({
      workspaceId: r.workspaceId,
      owner: r.owner,
      checkpointAt: r.checkpointAt,
      windowStart: r.windowStart,
      runningMs: r.runningMs,
      stoppedMs: r.stoppedMs,
      phase: r.phase,
    }));
  }

  async replaceAll(records: readonly CostRollupRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.entity.put([...records]).go();
  }
}
