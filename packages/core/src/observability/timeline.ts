// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IsoTimestamp } from "../domain/ids";

/**
 * A point on a workspace's derived lifecycle timeline. With no dedicated event
 * store, these are reconstructed from the workspace's current record (created /
 * last snapshot / last activity); the full per-action history comes from
 * CloudTrail on AWS (`docs/admin-ui-design.md`).
 */
export interface TimelineEvent {
  readonly at: IsoTimestamp;
  readonly event: string;
  readonly detail: string;
}

export interface WorkspaceTimelineInput {
  readonly createdAt: IsoTimestamp;
  readonly lastActivity: IsoTimestamp;
  readonly latestSnapshotAt?: IsoTimestamp;
}

/** Derive a workspace's lifecycle timeline from its current record (oldest first). */
export function deriveWorkspaceTimeline(ws: WorkspaceTimelineInput): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { at: ws.createdAt, event: "created", detail: "workspace provisioned" },
  ];
  if (ws.latestSnapshotAt !== undefined) {
    events.push({ at: ws.latestSnapshotAt, event: "snapshot", detail: "latest snapshot taken" });
  }
  if (ws.lastActivity !== ws.createdAt) {
    events.push({ at: ws.lastActivity, event: "activity", detail: "last activity observed" });
  }
  // Order by parsed INSTANT, not string compare: equivalent ISO timestamps in
  // different surface forms (`Z` vs `+00:00`, `.000` vs none) must order
  // chronologically, or a later event could sort before an earlier one (the same
  // hazard cost.ts guards). Today's records are all canonical `toISOString()`, but the
  // identical audit shape is filled from CloudTrail `LookupEvents` on AWS.
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
