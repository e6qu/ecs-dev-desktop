// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  deriveFleetAudit,
  isoTimestamp,
  WORKSPACE_STATES,
  type AuditEvent,
  type AuditSource,
  type FleetAuditInput,
} from "@edd/core";
import type { WorkspaceEntity } from "@edd/db";

export interface DerivedAuditSourceDeps {
  workspaces: WorkspaceEntity;
}

/** The fields the audit derivation reads off a persisted workspace record. */
interface AuditRecord {
  id: string;
  createdAt: string;
  lastActivity: string;
  latestSnapshotAt?: string;
}

/**
 * Local `AuditSource`: derives the fleet audit feed from the current workspace
 * records (no event store). The durable, actor-attributed source is **CloudTrail**
 * on AWS — same `AuditEvent` shape, a different adapter swapped in by config
 * (`AGENTS.md` §6.8, `docs/admin-ui-design.md`).
 */
export class DerivedAuditSource implements AuditSource {
  constructor(private readonly deps: DerivedAuditSourceDeps) {}

  async recent(limit?: number): Promise<AuditEvent[]> {
    // The state index holds exactly the workspace records; scanning this single
    // table read every session and audit row to find them.
    const pages = await Promise.all(
      WORKSPACE_STATES.map((state) =>
        this.deps.workspaces.query.byState({ state }).go({ pages: "all" }),
      ),
    );
    const data = pages.flatMap((page) => page.data);
    const inputs: FleetAuditInput[] = data.map((r: AuditRecord) => ({
      workspaceId: r.id,
      createdAt: isoTimestamp(r.createdAt),
      lastActivity: isoTimestamp(r.lastActivity),
      ...(r.latestSnapshotAt === undefined
        ? {}
        : { latestSnapshotAt: isoTimestamp(r.latestSnapshotAt) }),
    }));
    return limit === undefined ? deriveFleetAudit(inputs) : deriveFleetAudit(inputs, limit);
  }
}
