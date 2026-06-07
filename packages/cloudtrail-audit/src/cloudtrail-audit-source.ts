// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailClient, LookupEventsCommand, type Event } from "@aws-sdk/client-cloudtrail";
import {
  DEFAULT_AUDIT_FEED_LIMIT,
  isoTimestamp,
  type AuditEvent,
  type AuditSource,
} from "@edd/core";

/**
 * `AuditSource` backed by CloudTrail `LookupEvents`. On AWS this surfaces the
 * real IAM principal (actor) for every management API call.  Differs from
 * `DerivedAuditSource` by endpoint configuration only (§6.8).
 */
export class CloudTrailAuditSource implements AuditSource {
  constructor(private readonly client: CloudTrailClient) {}

  static fromEnv(): CloudTrailAuditSource {
    return new CloudTrailAuditSource(new CloudTrailClient({}));
  }

  async recent(limit?: number): Promise<AuditEvent[]> {
    const max = limit ?? DEFAULT_AUDIT_FEED_LIMIT;
    const out = await this.client.send(new LookupEventsCommand({ MaxResults: max }));
    const events: AuditEvent[] = [];
    for (const e of out.Events ?? []) {
      const mapped = mapEvent(e);
      if (mapped !== null) events.push(mapped);
    }
    return events;
  }
}

export function mapEvent(e: Event): AuditEvent | null {
  if (e.EventTime === undefined || e.EventName === undefined) return null;
  return {
    at: isoTimestamp(e.EventTime.toISOString()),
    actor: e.Username ?? "unknown",
    action: e.EventName,
    target: e.Resources?.[0]?.ResourceName ?? e.EventSource ?? "unknown",
    detail: e.EventId ?? "",
  };
}
