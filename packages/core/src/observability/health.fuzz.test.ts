// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the health roll-up. `summarizeHealth` is the
// severity-max over its components (with `unknown` ranking equal to `ok`), is
// order-independent, and returns `ok` on empty input. `reconcilerHealthFromHeartbeat` is
// monotone in age and boundary-correct at exactly `staleAfterMs`. Time is controlled —
// ages/now are passed in, never read from the real clock (CLAUDE.md §6.10).
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isoTimestamp, type IsoTimestamp } from "../domain/ids";
import {
  reconcilerHealthFromHeartbeat,
  summarizeHealth,
  type ComponentHealth,
  type HealthStatus,
} from "./health";

const CHECKED_AT: IsoTimestamp = isoTimestamp("2026-01-01T00:00:00.000Z");
// `unknown` ranks with `ok` (severity 0) — the roll-up's documented contract.
const SEVERITY: Record<HealthStatus, number> = { ok: 0, unknown: 0, degraded: 1, down: 2 };
const statusArb = fc.constantFrom<HealthStatus>("ok", "degraded", "down", "unknown");

const componentArb: fc.Arbitrary<ComponentHealth> = fc.record({
  component: fc.string({ minLength: 1 }),
  status: statusArb,
  detail: fc.option(fc.string(), { nil: undefined }),
});
const componentsArb = fc.array(componentArb, { maxLength: 12 });

/** The severity-max status the roll-up should report — ties resolve to whichever the
 * left fold reached first, but only the SEVERITY VALUE is observable, so compare on that. */
const expectedSeverity = (cs: readonly ComponentHealth[]): number =>
  cs.reduce((m, c) => Math.max(m, SEVERITY[c.status]), 0);

describe("summarizeHealth — properties", () => {
  it("equals the severity-max over its components (unknown ranks as ok)", () => {
    fc.assert(
      fc.property(componentsArb, (components) => {
        const report = summarizeHealth(components, CHECKED_AT);
        // Compare on severity VALUE, not on the literal status: ties between equal-
        // severity statuses (e.g. ok vs unknown) are resolved by fold order, which is not
        // a guaranteed-stable choice to assert on.
        expect(SEVERITY[report.status]).toBe(expectedSeverity(components));
        expect(report.checkedAt).toBe(CHECKED_AT);
        expect(report.components).toBe(components);
      }),
    );
  });

  it("is order-independent on a permutation of the same components", () => {
    // Build one base array, then a guaranteed-permutation of it (a full-length shuffled
    // subarray of its own indices) — so the two inputs are the same multiset, just
    // reordered. Independent draws would NOT relate.
    const permutedArb = componentsArb.chain((components) =>
      fc
        .shuffledSubarray(
          components.map((_, i) => i),
          { minLength: components.length, maxLength: components.length },
        )
        .map((order) => ({
          components,
          permuted: order
            .map((i) => components[i])
            .filter((c): c is ComponentHealth => c !== undefined),
        })),
    );
    fc.assert(
      fc.property(permutedArb, ({ components, permuted }) => {
        const a = summarizeHealth(components, CHECKED_AT);
        const b = summarizeHealth(permuted, CHECKED_AT);
        // The severity-max is invariant under permutation.
        expect(SEVERITY[b.status]).toBe(SEVERITY[a.status]);
      }),
    );
  });

  it("empty input rolls up to ok", () => {
    expect(summarizeHealth([], CHECKED_AT).status).toBe("ok");
  });

  it("a single down component dominates the roll-up", () => {
    fc.assert(
      fc.property(componentsArb, (components) => {
        const withDown: ComponentHealth[] = [...components, { component: "x", status: "down" }];
        expect(summarizeHealth(withDown, CHECKED_AT).status).toBe("down");
      }),
    );
  });
});

const NOW_MS = Date.parse("2026-06-01T12:00:00.000Z");
const STALE = 15 * 60 * 1000;

describe("reconcilerHealthFromHeartbeat — controlled-time properties", () => {
  it("no heartbeat → unknown (never run)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 86_400_000 }), (stale) => {
        expect(
          reconcilerHealthFromHeartbeat(
            undefined,
            isoTimestamp(new Date(NOW_MS).toISOString()),
            stale,
          ).status,
        ).toBe("unknown");
      }),
    );
  });

  it("monotone in age + boundary-correct at exactly staleAfterMs (<= is ok)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 86_400_000 }), (ageMs) => {
        const now = isoTimestamp(new Date(NOW_MS).toISOString());
        const lastRun = isoTimestamp(new Date(NOW_MS - ageMs).toISOString());
        const status = reconcilerHealthFromHeartbeat(lastRun, now, STALE).status;
        // Boundary: age == STALE is still ok (`ageMs <= staleAfterMs`).
        const expected: HealthStatus = ageMs <= STALE ? "ok" : "degraded";
        expect(status).toBe(expected);
      }),
    );
  });

  it("is monotone: a fresher sweep is never worse than a staler one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 86_400_000 }),
        fc.integer({ min: 0, max: 86_400_000 }),
        (ageA, ageB) => {
          const fresh = Math.min(ageA, ageB);
          const stale = Math.max(ageA, ageB);
          const now = isoTimestamp(new Date(NOW_MS).toISOString());
          const sevFresh =
            SEVERITY[
              reconcilerHealthFromHeartbeat(
                isoTimestamp(new Date(NOW_MS - fresh).toISOString()),
                now,
                STALE,
              ).status
            ];
          const sevStale =
            SEVERITY[
              reconcilerHealthFromHeartbeat(
                isoTimestamp(new Date(NOW_MS - stale).toISOString()),
                now,
                STALE,
              ).status
            ];
          expect(sevFresh).toBeLessThanOrEqual(sevStale);
        },
      ),
    );
  });

  it("exactly at the boundary: STALE → ok, STALE+1 → degraded", () => {
    const now = isoTimestamp(new Date(NOW_MS).toISOString());
    expect(
      reconcilerHealthFromHeartbeat(
        isoTimestamp(new Date(NOW_MS - STALE).toISOString()),
        now,
        STALE,
      ).status,
    ).toBe("ok");
    expect(
      reconcilerHealthFromHeartbeat(
        isoTimestamp(new Date(NOW_MS - STALE - 1).toISOString()),
        now,
        STALE,
      ).status,
    ).toBe("degraded");
  });
});
