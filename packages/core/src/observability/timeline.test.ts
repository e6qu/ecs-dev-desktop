// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isoTimestamp } from "../domain/ids";
import { deriveWorkspaceTimeline } from "./timeline";

const t = (h: number) => isoTimestamp(`2026-06-04T0${h.toString()}:00:00.000Z`);

describe("deriveWorkspaceTimeline", () => {
  it("starts with the created event", () => {
    const events = deriveWorkspaceTimeline({ createdAt: t(0), lastActivity: t(0) });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("created");
  });

  it("includes snapshot and activity, ordered oldest first", () => {
    const events = deriveWorkspaceTimeline({
      createdAt: t(0),
      lastActivity: t(3),
      latestSnapshotAt: t(1),
    });
    expect(events.map((e) => e.event)).toEqual(["created", "snapshot", "activity"]);
  });

  it("omits the activity event when there has been none since creation", () => {
    const events = deriveWorkspaceTimeline({ createdAt: t(0), lastActivity: t(0) });
    expect(events.some((e) => e.event === "activity")).toBe(false);
  });

  it("omits a spurious activity event when createdAt/lastActivity are the same instant in different surface forms", () => {
    // CloudTrail LookupEvents can surface the SAME instant as `+00:00`/no-millis rather than
    // canonical `Z` — the dedup must compare instants, not strings, or it fabricates a
    // duplicate "activity" event at the creation instant.
    const events = deriveWorkspaceTimeline({
      createdAt: isoTimestamp("2026-06-04T00:00:00.000Z"),
      lastActivity: isoTimestamp("2026-06-04T00:00:00+00:00"),
    });
    expect(events.some((e) => e.event === "activity")).toBe(false);
  });

  it("keeps both snapshot and activity when they share a timestamp", () => {
    const events = deriveWorkspaceTimeline({
      createdAt: t(0),
      lastActivity: t(2),
      latestSnapshotAt: t(2),
    });
    expect(events.map((e) => e.event)).toEqual(["created", "snapshot", "activity"]);
  });

  it("sorts by timestamp even when the snapshot is newer than the last activity", () => {
    const events = deriveWorkspaceTimeline({
      createdAt: t(0),
      lastActivity: t(1),
      latestSnapshotAt: t(3),
    });
    expect(events.map((e) => e.event)).toEqual(["created", "activity", "snapshot"]);
  });
});
