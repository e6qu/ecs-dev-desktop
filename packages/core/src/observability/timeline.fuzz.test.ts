// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the derived lifecycle timeline + fleet audit
// feed. The load-bearing invariant is INSTANT ordering, independent of the ISO surface
// form: the same audit shape is filled from CloudTrail on AWS, whose timestamps may be
// `+hh:mm` offset forms rather than `Z` — a string compare (the prior bug) would
// mis-order them, so the timeline could list a later event first and the capped audit
// feed could drop the genuinely-newest event. Also pins the `deriveFleetAudit` limit
// fail-loud guard and the cap.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isoTimestamp, type IsoTimestamp } from "../domain/ids";
import { deriveFleetAudit, type FleetAuditInput } from "./audit";
import { deriveWorkspaceTimeline } from "./timeline";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

/** An ISO timestamp at `BASE + ms`, randomly rendered as a `Z` form or an equivalent
 * `+hh:00` offset form — so the value is identical in INSTANT but differs in string. */
const isoAtArb = (ms: number, offsetHours: number): IsoTimestamp => {
  if (offsetHours === 0) return isoTimestamp(new Date(BASE + ms).toISOString());
  // Shift the wall-clock by the offset and append it, preserving the instant.
  const shifted = new Date(BASE + ms + offsetHours * 3_600_000);
  const sign = offsetHours > 0 ? "+" : "-";
  const hh = String(Math.abs(offsetHours)).padStart(2, "0");
  return isoTimestamp(`${shifted.toISOString().replace(/\.\d{3}Z$/, "")}${sign}${hh}:00`);
};

const offsetArb = fc.integer({ min: -12, max: 12 });

describe("deriveWorkspaceTimeline — properties", () => {
  it("orders points by INSTANT regardless of ISO surface form", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        offsetArb,
        offsetArb,
        (snapMs, actMs, o1, o2) => {
          const events = deriveWorkspaceTimeline({
            createdAt: isoAtArb(0, 0),
            latestSnapshotAt: isoAtArb(snapMs, o1),
            lastActivity: isoAtArb(actMs, o2),
          });
          for (let i = 1; i < events.length; i++) {
            const prev = events[i - 1];
            const cur = events[i];
            if (prev !== undefined && cur !== undefined) {
              expect(Date.parse(prev.at)).toBeLessThanOrEqual(Date.parse(cur.at));
            }
          }
        },
      ),
    );
  });
});

describe("deriveFleetAudit — properties", () => {
  it("is newest-first by instant, honours the cap, and never exceeds limit", () => {
    const inputArb = fc.array(
      fc.record({
        n: fc.integer({ min: 0, max: 1000 }),
        snapMs: fc.integer({ min: 1, max: 5_000_000 }),
        actMs: fc.integer({ min: 1, max: 5_000_000 }),
        o: offsetArb,
      }),
      { minLength: 0, maxLength: 12 },
    );
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 0, max: 30 }), (rows, limit) => {
        const items: FleetAuditInput[] = rows.map((r) => ({
          workspaceId: `ws-${String(r.n)}`,
          createdAt: isoAtArb(0, 0),
          latestSnapshotAt: isoAtArb(r.snapMs, r.o),
          lastActivity: isoAtArb(r.actMs, r.o),
        }));
        const feed = deriveFleetAudit(items, limit);
        expect(feed.length).toBeLessThanOrEqual(limit);
        for (let i = 1; i < feed.length; i++) {
          const prev = feed[i - 1];
          const cur = feed[i];
          if (prev !== undefined && cur !== undefined) {
            expect(Date.parse(prev.at)).toBeGreaterThanOrEqual(Date.parse(cur.at)); // newest-first
          }
        }
      }),
    );
  });

  it("fails loud on a negative / non-integer limit", () => {
    const items: FleetAuditInput[] = [
      { workspaceId: "ws-1", createdAt: isoAtArb(0, 0), lastActivity: isoAtArb(1000, 0) },
    ];
    for (const bad of [-1, -10, 1.5, Number.NaN]) {
      expect(() => deriveFleetAudit(items, bad)).toThrow();
    }
  });
});
