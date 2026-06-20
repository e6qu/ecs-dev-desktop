// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_AUDIT_FEED_LIMIT } from "../domain/constants";
import type { IsoTimestamp } from "../domain/ids";

import { deriveWorkspaceTimeline } from "./timeline";

/**
 * One audit record: who did what to which resource, when. With no dedicated
 * event store, the local source *derives* these from each workspace's current
 * record (so `actor` is `system` — the state implies the action, not an actor).
 * On AWS the same shape is filled from **CloudTrail** `LookupEvents`, where the
 * actor is the real IAM principal (`docs/admin-ui-design.md`).
 */
export interface AuditEvent {
  readonly at: IsoTimestamp;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
}

/** The fields of a workspace record the derived audit feed reads. */
export interface FleetAuditInput {
  readonly workspaceId: string;
  readonly createdAt: IsoTimestamp;
  readonly lastActivity: IsoTimestamp;
  readonly latestSnapshotAt?: IsoTimestamp;
}

/** The actor attributed to state-derived events (no real principal is stored). */
const DERIVED_ACTOR = "system";

/**
 * Pure: derive a fleet-wide audit feed (newest first, capped) from the current
 * workspace records. Reuses each workspace's derived lifecycle timeline so the
 * Inspect timeline and the audit feed never diverge.
 */
export function deriveFleetAudit(
  items: readonly FleetAuditInput[],
  limit: number = DEFAULT_AUDIT_FEED_LIMIT,
): AuditEvent[] {
  // A negative limit would slice from the END (dropping the newest events) and return
  // a non-empty but wrong feed; fail loud rather than silently mis-slice (§6.5).
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`deriveFleetAudit: limit must be a non-negative integer, got ${String(limit)}`);
  }
  const events = items.flatMap((w) =>
    deriveWorkspaceTimeline({
      createdAt: w.createdAt,
      lastActivity: w.lastActivity,
      ...(w.latestSnapshotAt === undefined ? {} : { latestSnapshotAt: w.latestSnapshotAt }),
    }).map(
      (e): AuditEvent => ({
        at: e.at,
        actor: DERIVED_ACTOR,
        action: `workspace.${e.event}`,
        target: w.workspaceId,
        detail: e.detail,
      }),
    ),
  );
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Source of audit events. Derived from state now; CloudTrail-backed on AWS. */
export interface AuditSource {
  recent(limit?: number): Promise<AuditEvent[]>;
}
