// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LookupEventsCommand, LookupEventsCommandOutput } from "@aws-sdk/client-cloudtrail";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { describe, expect, it, vi } from "vitest";

import { CloudTrailAuditSource, mapEvent } from "./cloudtrail-audit-source";

// ── mapEvent (pure) ─────────────────────────────────────────────────────────

describe("mapEvent", () => {
  const AT = new Date("2026-06-06T10:00:00.000Z");

  it("maps a full CloudTrail event to an AuditEvent", () => {
    const result = mapEvent({
      EventTime: AT,
      EventName: "RunTask",
      EventId: "abc-123",
      EventSource: "ecs.amazonaws.com",
      Username: "alice",
      Resources: [{ ResourceName: "arn:aws:ecs:us-east-1:123:cluster/edd" }],
    });
    expect(result).toStrictEqual({
      at: "2026-06-06T10:00:00.000Z",
      actor: "alice",
      action: "RunTask",
      target: "arn:aws:ecs:us-east-1:123:cluster/edd",
      detail: "abc-123",
    });
  });

  it("falls back to EventSource when Resources is empty", () => {
    const result = mapEvent({
      EventTime: AT,
      EventName: "PutItem",
      EventSource: "dynamodb.amazonaws.com",
      Resources: [],
    });
    expect(result?.target).toBe("dynamodb.amazonaws.com");
  });

  it("falls back to 'unknown' actor when Username is absent", () => {
    const result = mapEvent({ EventTime: AT, EventName: "DescribeTable" });
    expect(result?.actor).toBe("unknown");
  });

  it("returns null when EventTime is missing", () => {
    expect(mapEvent({ EventName: "RunTask" })).toBeNull();
  });

  it("returns null when EventName is missing", () => {
    expect(mapEvent({ EventTime: AT })).toBeNull();
  });
});

// ── CloudTrailAuditSource (mock client) ─────────────────────────────────────

describe("CloudTrailAuditSource", () => {
  function makeSource(events: LookupEventsCommandOutput["Events"]): CloudTrailAuditSource {
    const mockSend = vi.fn().mockResolvedValue({ Events: events });
    return new CloudTrailAuditSource({ send: mockSend } as unknown as CloudTrailClient);
  }

  it("returns mapped events from LookupEvents", async () => {
    const src = makeSource([
      {
        EventTime: new Date("2026-06-06T12:00:00.000Z"),
        EventName: "StopTask",
        Username: "bob",
        EventSource: "ecs.amazonaws.com",
      },
    ]);
    const events = await src.recent();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("StopTask");
    expect(events[0]?.actor).toBe("bob");
  });

  it("filters out events with missing EventTime or EventName", async () => {
    const src = makeSource([
      { EventName: "NoTime" },
      { EventTime: new Date("2026-06-06T12:00:00.000Z") },
      { EventTime: new Date("2026-06-06T12:00:01.000Z"), EventName: "ValidEvent" },
    ]);
    const events = await src.recent();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("ValidEvent");
  });

  it("returns empty array when LookupEvents returns no events", async () => {
    const src = makeSource([]);
    expect(await src.recent()).toEqual([]);
  });

  it("returns empty array when Events is undefined", async () => {
    const src = makeSource(undefined);
    expect(await src.recent()).toEqual([]);
  });

  it("passes the limit as MaxResults", async () => {
    const mockSend = vi.fn().mockResolvedValue({ Events: [] });
    const source = new CloudTrailAuditSource({ send: mockSend } as unknown as CloudTrailClient);
    await source.recent(7);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: { MaxResults: 7 } }));
  });

  const evt = (name: string): NonNullable<LookupEventsCommandOutput["Events"]>[number] => ({
    EventTime: new Date("2026-06-06T12:00:00.000Z"),
    EventName: name,
  });

  it("follows NextToken across pages until the limit is collected", async () => {
    const mockSend = vi
      .fn()
      .mockResolvedValueOnce({ Events: [evt("A"), evt("B")], NextToken: "t1" })
      .mockResolvedValueOnce({ Events: [evt("C")] });
    const src = new CloudTrailAuditSource({ send: mockSend } as unknown as CloudTrailClient);

    const events = await src.recent(10);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.action)).toEqual(["A", "B", "C"]);
    // The second page request carried the first page's NextToken.
    const secondCall = mockSend.mock.calls[1] as [LookupEventsCommand];
    expect(secondCall[0].input).toMatchObject({ NextToken: "t1" });
  });

  it("stops at the limit without fetching further pages", async () => {
    // Every page is full and offers another NextToken; once `limit` is reached we
    // must not keep paging.
    const mockSend = vi.fn().mockResolvedValue({ Events: [evt("A"), evt("B")], NextToken: "more" });
    const src = new CloudTrailAuditSource({ send: mockSend } as unknown as CloudTrailClient);

    const events = await src.recent(2);

    expect(events).toHaveLength(2);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
