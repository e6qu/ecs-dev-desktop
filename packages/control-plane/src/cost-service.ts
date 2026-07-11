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
  type CostIssue,
  type WorkspaceSizing,
} from "@edd/core";

/** Audit-action prefix for billable lifecycle events (session.create/start/…). */
const SESSION_ACTION_PREFIX = "session.";

/** ElectroDB batch put/delete map to DynamoDB `BatchWriteItem`, which returns
 * `UnprocessedItems` under throttling/partial failure — ElectroDB surfaces these in
 * `unprocessed` and does NOT auto-retry. Discarding them would silently drop cost
 * checkpoint rows (a stale/double-counted report). Fail loud so the next reconciler
 * sweep re-runs the idempotent `replaceAll` instead (§6.5). */
function assertAllProcessed(unprocessed: readonly unknown[], op: "put" | "delete"): void {
  if (unprocessed.length > 0) {
    throw new Error(
      `cost rollup ${op} left ${String(unprocessed.length)} unprocessed item(s) (DynamoDB BatchWriteItem throttle); rollup not persisted`,
    );
  }
}

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
export interface CostRollupCheckpoint {
  readonly workspaceId: string;
  readonly owner: string;
  readonly checkpointAt: string;
  readonly windowStart: string;
  readonly priced: true;
  readonly sizing: WorkspaceSizing;
  readonly runningMs: number;
  readonly stoppedMs: number;
  readonly teardownMs: number;
  readonly phase: string;
}

/** A workspace the rollup could NOT price (e.g. a legacy `session.create` with no
 * structured resources). Persisted so the rollup report surfaces it in `unpriced`
 * exactly like the full scan does — instead of the whole rollup failing, or the
 * workspace silently vanishing from the checkpointed report. */
interface CostRollupUnpriced {
  readonly workspaceId: string;
  readonly owner: string;
  readonly checkpointAt: string;
  readonly windowStart: string;
  readonly priced: false;
  readonly reason: string;
}

export type CostRollupRecord = CostRollupCheckpoint | CostRollupUnpriced;

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

function resourcesToSizing(
  workspaceId: string,
  resources: WorkspaceDto["resources"],
): WorkspaceSizing {
  if (
    !Number.isFinite(resources.cpuUnits) ||
    resources.cpuUnits <= 0 ||
    !Number.isFinite(resources.memoryMiB) ||
    resources.memoryMiB <= 0 ||
    !Number.isFinite(resources.volumeGiB) ||
    resources.volumeGiB <= 0
  ) {
    throw new Error(
      `cost report cannot price workspace ${workspaceId}: workspace resources are not finite positive numbers`,
    );
  }
  return {
    vcpu: resources.cpuUnits / 1024,
    memoryGib: resources.memoryMiB / 1024,
    volumeGib: resources.volumeGiB,
  };
}

function sizingFromCreateEvent(
  events: readonly AuditEvent[],
  workspaceId: string,
): WorkspaceSizing {
  const created = events.find((e) => e.action === "session.create");
  if (created?.resources === undefined) {
    throw new Error(
      `cost report cannot price workspace ${workspaceId}: session.create audit event has no structured resources`,
    );
  }
  return resourcesToSizing(workspaceId, created.resources);
}

function sizingOf(
  workspaceId: string,
  events: readonly AuditEvent[],
  record: WorkspaceDto | undefined,
): WorkspaceSizing {
  return record === undefined
    ? sizingFromCreateEvent(events, workspaceId)
    : resourcesToSizing(workspaceId, record.resources);
}

/** Earliest event timestamp across the ledger (the window start), or `now`. */
function earliestAt(events: readonly AuditEvent[], now: string): string {
  let earliest = now;
  for (const e of events) if (e.at.localeCompare(earliest) < 0) earliest = e.at;
  return earliest;
}

const PHASES = new Set(["running", "stopped", "teardown", "retained", "none", "terminated"]);
function asPhase(value: string, workspaceId: string): BillingState["phase"] {
  if (!PHASES.has(value)) {
    throw new Error(`cost rollup for ${workspaceId} has invalid billing phase '${value}'`);
  }
  return value as BillingState["phase"];
}

/** Sentinel `phase` value marking a persisted unpriced-workspace rollup row. */
const UNPRICED_PHASE = "unpriced";

/** The chronologically earliest of two ISO instants (fail loud on unparseable). */
function earlierIso(a: string, b: string): string {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
    throw new Error(`cost rollup has an unparseable timestamp: '${a}' / '${b}'`);
  }
  return aMs <= bMs ? a : b;
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
   * Prices the whole ledger once here so `report` doesn't have to per request.
   * A workspace that cannot be sized (e.g. a legacy `session.create` without
   * structured resources) must not poison the whole rollup: it is checkpointed as
   * an `unpriced` marker — surfaced by the report exactly like the full scan's
   * `unpriced` list — while every priceable workspace still gets its checkpoint. */
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
    const out: CostRollupRecord[] = [...ids].map((id): CostRollupRecord => {
      const wsEvents = byWorkspace.get(id) ?? [];
      const base = {
        workspaceId: id,
        owner: ownerOf(wsEvents, records.get(id)),
        checkpointAt: now,
        windowStart,
      };
      let sizing: WorkspaceSizing;
      try {
        sizing = sizingOf(id, wsEvents, records.get(id));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { ...base, priced: false, reason: error.message };
      }
      const state = deriveBillingState(wsEvents, now);
      return {
        ...base,
        priced: true,
        sizing,
        runningMs: state.runningMs,
        stoppedMs: state.stoppedMs,
        teardownMs: state.teardownMs,
        phase: state.phase,
      };
    });
    await this.deps.rollups.replaceAll(out);
  }

  /**
   * Regenerate the checkpoints only if the newest is older than `maxAgeMs` (or none
   * exist), so `report()` stays O(recent) — replaying only the tail since the last
   * checkpoint — instead of full-scanning the whole append-only ledger on every read.
   * The reconciler calls this each sweep; the cadence bounds the replay tail without
   * pricing the entire ledger every sweep. No-op when no rollup store is wired.
   * Figures are unchanged (the rollup is byte-equivalent to the full scan — proven by
   * the figure-equivalence integ); this only controls WHEN checkpoints are refreshed.
   */
  async rollupIfStale(maxAgeMs: number): Promise<void> {
    if (this.deps.rollups === undefined) return;
    const existing = await this.deps.rollups.list();
    const first = existing[0];
    if (first === undefined) {
      await this.rollup();
      return;
    }
    // One generation shares a single `checkpointAt`; MIXED checkpoints mean a
    // partially-failed replaceAll left rows from two generations — regenerate
    // regardless of age. Otherwise stale when the OLDEST checkpoint is (so a
    // single surviving old row can't keep the set "fresh").
    let oldest = first.checkpointAt;
    let mixed = false;
    for (const r of existing) {
      if (r.checkpointAt !== first.checkpointAt) mixed = true;
      oldest = earlierIso(oldest, r.checkpointAt);
    }
    if (!mixed && Date.parse(this.now()) - Date.parse(oldest) < maxAgeMs) return;
    await this.rollup();
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
    const unpriced: CostIssue[] = [];
    const inputs: WorkspaceCostInput[] = [...ids].flatMap((id) => {
      const wsEvents = byWorkspace.get(id) ?? [];
      const record = records.get(id);
      try {
        return [
          {
            workspaceId: id,
            owner: ownerOf(wsEvents, record),
            ...(record === undefined ? {} : { state: record.state }),
            sizing: sizingOf(id, wsEvents, record),
            events: wsEvents,
          },
        ];
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        unpriced.push({ workspaceId: id, reason: error.message });
        return [];
      }
    });
    // The ledger start counts EVERY event — including an unpriceable session's —
    // so the lifetime report's windowStart matches the rollup path (whose
    // checkpoints persist the same all-events start).
    return computeFleetCost(
      inputs,
      this.deps.pricing,
      now,
      window,
      unpriced,
      isoTimestamp(earliestAt(events, now)),
    );
  }

  /** Price from the checkpoints + the events since them (O(recent)). Resuming each
   * workspace's checkpoint and replaying only the tail yields the same figures the
   * full scan would (proven by the figure-equivalence integ). Each row resumes from
   * its OWN persisted `checkpointAt`: after a partial BatchWrite failure rows from
   * two generations coexist, and replaying an older row from a newer row's
   * checkpoint would silently drop (or double-count) the time between them. */
  private async rollupReport(
    rollups: readonly CostRollupRecord[],
    now: IsoTimestamp,
  ): Promise<FleetCostReport> {
    // The tail must reach back to the OLDEST row's checkpoint so every row's own
    // resume window — and any workspace born after that instant — is fully covered;
    // `resumeBilling` filters each row's tail to `(its checkpoint, now]`.
    const oldestCheckpoint = isoTimestamp(
      rollups.reduce<string>((acc, r) => earlierIso(acc, r.checkpointAt), now),
    );
    const windowStart = isoTimestamp(
      rollups.reduce<string>((acc, r) => earlierIso(acc, r.windowStart), now),
    );
    const [tail, workspaces] = await Promise.all([
      this.deps.audit.since(oldestCheckpoint),
      this.deps.workspaces.list(),
    ]);
    const tailByWorkspace = groupSessions(tail);
    const records = new Map(workspaces.map((w) => [w.id, w]));
    const { pricing } = this.deps;
    const bySession: SessionCost[] = [];
    const unpriced: CostIssue[] = [];
    const rolled = new Set<string>();

    for (const r of rollups) {
      rolled.add(r.workspaceId);
      if (!r.priced) {
        unpriced.push({ workspaceId: r.workspaceId, reason: r.reason });
        continue;
      }
      const tailEvents = tailByWorkspace.get(r.workspaceId) ?? [];
      const state: BillingState = {
        runningMs: r.runningMs,
        stoppedMs: r.stoppedMs,
        teardownMs: r.teardownMs,
        phase: asPhase(r.phase, r.workspaceId),
      };
      const resumed = resumeBilling(state, isoTimestamp(r.checkpointAt), tailEvents, now);
      const record = records.get(r.workspaceId);
      bySession.push({
        workspaceId: r.workspaceId,
        owner: r.owner,
        sizing: r.sizing,
        state: record?.state ?? (resumed.terminated ? "terminated" : "unknown"),
        terminated: resumed.terminated,
        ...priceDurations(
          resumed.runningMs,
          resumed.stoppedMs,
          resumed.teardownMs,
          pricing,
          r.sizing,
        ),
      });
    }

    // Workspaces born after the checkpoint: all their events are in the tail.
    for (const [id, tailEvents] of tailByWorkspace) {
      if (rolled.has(id)) continue;
      const intervals = deriveBillingIntervals(tailEvents, now);
      const record = records.get(id);
      let sizing: WorkspaceSizing;
      try {
        sizing = sizingOf(id, tailEvents, record);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        unpriced.push({ workspaceId: id, reason: error.message });
        continue;
      }
      bySession.push({
        workspaceId: id,
        owner: ownerOf(tailEvents, record),
        sizing,
        state: record?.state ?? (intervals.terminated ? "terminated" : "unknown"),
        terminated: intervals.terminated,
        ...priceIntervals(intervals, pricing, sizing),
      });
    }

    return aggregateFleetCost(bySession, pricing, now, windowStart, unpriced);
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
    return data.map((r): CostRollupRecord => {
      const base = {
        workspaceId: r.workspaceId,
        owner: r.owner,
        checkpointAt: r.checkpointAt,
        windowStart: r.windowStart,
      };
      if (r.phase === UNPRICED_PHASE) {
        // An unpriced marker row (see `rollup`); its reason is mandatory — a
        // marker without one is a corrupt row, not a silently-empty report line.
        if (r.unpricedReason === undefined) {
          throw new Error(`cost rollup for ${r.workspaceId} is unpriced but carries no reason`);
        }
        return { ...base, priced: false, reason: r.unpricedReason };
      }
      return {
        ...base,
        priced: true,
        sizing: {
          vcpu: r.vcpu,
          memoryGib: r.memoryGib,
          volumeGib: r.volumeGib,
        },
        runningMs: r.runningMs,
        stoppedMs: r.stoppedMs,
        teardownMs: r.teardownMs,
        phase: r.phase,
      };
    });
  }

  async replaceAll(records: readonly CostRollupRecord[]): Promise<void> {
    // A true replace: delete any checkpoint absent from the new generation (a
    // workspace that left the ledger) before upserting the rest, so a stale rollup
    // row can never be double-counted by `rollupReport`. Today the audit ledger is
    // append-only, so the id set is monotonic and the delete is a no-op — but this
    // keeps the swap correct if that invariant ever changes, rather than relying on it.
    const keep = new Set(records.map((r) => r.workspaceId));
    const stale = (await this.list()).filter((r) => !keep.has(r.workspaceId));
    if (stale.length > 0) {
      const { unprocessed } = await this.entity
        .delete(stale.map((r) => ({ workspaceId: r.workspaceId })))
        .go();
      assertAllProcessed(unprocessed, "delete");
    }
    if (records.length > 0) {
      const { unprocessed } = await this.entity
        .put(
          records.map((r) => ({
            workspaceId: r.workspaceId,
            owner: r.owner,
            checkpointAt: r.checkpointAt,
            windowStart: r.windowStart,
            // An unpriced marker row has no billing state; the required numeric
            // attributes are stored as zero and the `unpriced` phase sentinel +
            // reason mark it (list() maps it back to `priced: false`).
            ...(r.priced
              ? {
                  vcpu: r.sizing.vcpu,
                  memoryGib: r.sizing.memoryGib,
                  volumeGib: r.sizing.volumeGib,
                  runningMs: r.runningMs,
                  stoppedMs: r.stoppedMs,
                  teardownMs: r.teardownMs,
                  phase: r.phase,
                }
              : {
                  vcpu: 0,
                  memoryGib: 0,
                  volumeGib: 0,
                  runningMs: 0,
                  stoppedMs: 0,
                  teardownMs: 0,
                  phase: UNPRICED_PHASE,
                  unpricedReason: r.reason,
                }),
          })),
        )
        .go();
      assertAllProcessed(unprocessed, "put");
    }
  }
}
