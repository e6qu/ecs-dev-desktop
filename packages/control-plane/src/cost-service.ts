// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import {
  computeFleetCost,
  isoTimestamp,
  type AuditEvent,
  type Clock,
  type FleetCostReport,
  type Pricing,
  type WorkspaceCostInput,
  type WorkspaceSizing,
} from "@edd/core";

/** Audit-action prefix for billable lifecycle events (session.create/start/…). */
const SESSION_ACTION_PREFIX = "session.";

/** The audit ledger the cost model prices. */
interface CostAuditSource {
  all(): Promise<AuditEvent[]>;
}

/** The workspace catalog the cost model attributes owners/state from. */
interface CostWorkspaceSource {
  list(): Promise<WorkspaceDto[]>;
}

export interface CostServiceDeps {
  audit: CostAuditSource;
  workspaces: CostWorkspaceSource;
  clock: Clock;
  pricing: Pricing;
  sizing: WorkspaceSizing;
}

/**
 * Imperative shell over the pure cost core (`computeFleetCost`). It gathers the
 * lifecycle audit ledger (the authoritative record of running vs. stopped time)
 * and the current workspace records (for owner/state attribution), groups events
 * per workspace, and prices them. All money math is pure and lives in `@edd/core`.
 */
export class CostService {
  constructor(private readonly deps: CostServiceDeps) {}

  async report(): Promise<FleetCostReport> {
    const [events, workspaces] = await Promise.all([
      this.deps.audit.all(),
      this.deps.workspaces.list(),
    ]);

    // Group lifecycle (session.*) events by workspace — repo/other actions are
    // not billable and form no session, so they are excluded here.
    const byWorkspace = new Map<string, AuditEvent[]>();
    for (const e of events) {
      if (!e.action.startsWith(SESSION_ACTION_PREFIX)) continue;
      const list = byWorkspace.get(e.target) ?? [];
      list.push(e);
      byWorkspace.set(e.target, list);
    }

    const records = new Map(workspaces.map((w) => [w.id, w]));
    const ids = new Set<string>([...byWorkspace.keys(), ...records.keys()]);

    const inputs: WorkspaceCostInput[] = [...ids].map((id) => {
      const wsEvents = byWorkspace.get(id) ?? [];
      const record = records.get(id);
      // Owner: the creator recorded on session.create (carries the email when
      // known), else the current record's owner id, else unknown (record gone +
      // created before the ledger existed).
      const created = wsEvents.find((e) => e.action === "session.create");
      const owner = created?.actor ?? record?.ownerId ?? "unknown";
      return {
        workspaceId: id,
        owner,
        ...(record === undefined ? {} : { state: record.state }),
        events: wsEvents,
      };
    });

    return computeFleetCost(inputs, this.deps.pricing, this.deps.sizing, this.now());
  }

  private now() {
    return isoTimestamp(this.deps.clock.now());
  }
}
