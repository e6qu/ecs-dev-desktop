// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import {
  DEFAULT_AUDIT_FEED_LIMIT,
  isoTimestamp,
  type AuditEvent,
  type AuditSource,
  type Clock,
} from "@edd/core";
import type { WorkspaceResources } from "@edd/core";
import type { AuditEventEntity } from "@edd/db";

/** The actor-attributed action to record (timestamp + id are assigned here). */
export interface AuditAction {
  actor: string;
  action: string;
  target: string;
  detail: string;
  resources?: WorkspaceResources;
}

interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  resources?: unknown;
}

export interface StoredAuditSourceDeps {
  events: AuditEventEntity;
  clock: Clock;
}

/**
 * First-class, append-only, actor-attributed audit log. `record` appends one
 * event per control-plane action (who did what, to what, when); `recent`
 * returns them newest-first for the admin feed. Distinct from the *derived*
 * fleet feed (lifecycle inferred from state) and from CloudTrail (AWS API
 * calls) — this captures user-facing actions with the acting identity.
 */
export class StoredAuditSource implements AuditSource {
  constructor(private readonly deps: StoredAuditSourceDeps) {}

  async record(action: AuditAction): Promise<void> {
    await this.deps.events
      .put({ id: `evt-${randomUUID()}`, at: this.deps.clock.now(), ...action })
      .go();
  }

  async recent(limit: number = DEFAULT_AUDIT_FEED_LIMIT): Promise<AuditEvent[]> {
    const { data } = await this.deps.events.query.byTime({}).go({ order: "desc", limit });
    return data.map(toEvent);
  }

  /** The entire ledger (fully paginated). The cost model reads this to price the
   * complete lifecycle history; order is unspecified (the consumer sorts). */
  async all(): Promise<AuditEvent[]> {
    const { data } = await this.deps.events.query.byTime({}).go({ pages: "all" });
    return data.map(toEvent);
  }

  /** Events after `fromExclusive` (the byTime tail). The cost rollup replays only
   * this slice on top of the checkpoint instead of re-reading the whole ledger.
   * Order is unspecified (the consumer sorts). */
  async since(fromExclusive: string): Promise<AuditEvent[]> {
    const { data } = await this.deps.events.query
      .byTime({})
      .gt({ at: fromExclusive })
      .go({ pages: "all" });
    return data.map(toEvent);
  }
}

function toEvent(r: AuditRecord): AuditEvent {
  if (r.resources !== undefined && !isWorkspaceResources(r.resources)) {
    throw new Error(`audit event ${r.id} contains invalid structured workspace resources`);
  }
  return {
    at: isoTimestamp(r.at),
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail,
    ...(r.resources === undefined ? {} : { resources: r.resources }),
  };
}

function isWorkspaceResources(value: unknown): value is WorkspaceResources {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return [candidate.cpuUnits, candidate.memoryMiB, candidate.volumeGiB].every(
    (item) => typeof item === "number" && Number.isFinite(item) && item > 0,
  );
}
