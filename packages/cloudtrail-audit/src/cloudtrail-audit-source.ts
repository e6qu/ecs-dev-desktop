// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudTrailClient,
  LookupEventsCommand,
  type Event,
  type LookupEventsCommandOutput,
} from "@aws-sdk/client-cloudtrail";
import { AWS_SDK_MAX_ATTEMPTS, AWS_SDK_RETRY_MODE } from "@edd/config";
import {
  DEFAULT_AUDIT_FEED_LIMIT,
  isoTimestamp,
  type AuditEvent,
  type AuditSource,
} from "@edd/core";

/** CloudTrail `LookupEvents` caps a single page at 50 results. */
const CLOUDTRAIL_PAGE_MAX = 50;

/**
 * `AuditSource` backed by CloudTrail `LookupEvents`. On AWS this surfaces the
 * real IAM principal (actor) for every management API call.  Differs from
 * `DerivedAuditSource` by endpoint configuration only (§6.8).
 */
export class CloudTrailAuditSource implements AuditSource {
  constructor(private readonly client: CloudTrailClient) {}

  static fromEnv(): CloudTrailAuditSource {
    // Adaptive retry: CloudTrail `LookupEvents` is aggressively throttled (~1-2 TPS),
    // so the paginated `recent()` loop benefits from the platform's backoff policy.
    return new CloudTrailAuditSource(
      new CloudTrailClient({ maxAttempts: AWS_SDK_MAX_ATTEMPTS, retryMode: AWS_SDK_RETRY_MODE }),
    );
  }

  async recent(limit?: number): Promise<AuditEvent[]> {
    const max = limit ?? DEFAULT_AUDIT_FEED_LIMIT;
    const events: AuditEvent[] = [];
    // LookupEvents returns at most 50 events per page; follow NextToken until we
    // have `max` mapped events (or run out). Without this the feed silently
    // truncated to the first page at volume — the same class as the resolved
    // DynamoDB quota-pagination bug.
    let nextToken: string | undefined;
    do {
      const out: LookupEventsCommandOutput = await this.client.send(
        new LookupEventsCommand({
          MaxResults: Math.min(max - events.length, CLOUDTRAIL_PAGE_MAX),
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
      );
      for (const e of out.Events ?? []) {
        const mapped = mapEvent(e);
        if (mapped !== null) events.push(mapped);
        if (events.length >= max) return events;
      }
      nextToken = out.NextToken;
    } while (nextToken !== undefined && events.length < max);
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
