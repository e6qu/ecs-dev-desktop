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
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
