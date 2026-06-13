// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import {
  DEFAULT_AUDIT_FEED_LIMIT,
  isoTimestamp,
  type AuditEvent,
  type AuditSource,
  type Clock,
} from "@edd/core";
import type { AuditEventEntity } from "@edd/db";

/** The actor-attributed action to record (timestamp + id are assigned here). */
export interface AuditAction {
  actor: string;
  action: string;
  target: string;
  detail: string;
}

interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
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
    return data.map((r: AuditRecord) => ({
      at: isoTimestamp(r.at),
      actor: r.actor,
      action: r.action,
      target: r.target,
      detail: r.detail,
    }));
  }
}
