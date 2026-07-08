// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based fuzz tests (fast-check) for aggregateFleetCost. Pins:
// total is order-independent (float non-associativity handled by canonical sort);
// byUser sum = bySession sum = fleet total; sort order is correct.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { aggregateFleetCost, type Pricing, type WorkspaceSizing, type SessionCost } from "./cost";

const PRICING: Pricing = {
  fargateVcpuHourUsd: 0.04,
  fargateGbHourUsd: 0.004,
  ebsGbMonthUsd: 0.08,
  snapshotGbMonthUsd: 0.05,
};
const SIZING: WorkspaceSizing = { vcpu: 1, memoryGib: 2, volumeGib: 30 };
const NOW = "2026-01-01T00:00:00.000Z" as never;

const sessionArb: fc.Arbitrary<SessionCost> = fc
  .record({
    workspaceId: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s as never),
    owner: fc.string({ minLength: 1, maxLength: 20 }),
    sizing: fc.constant(SIZING),
    state: fc.constantFrom("running", "stopped", "terminated", "error"),
    terminated: fc.boolean(),
    runningMs: fc.nat({ max: 100000 }),
    stoppedMs: fc.nat({ max: 100000 }),
    teardownMs: fc.nat({ max: 100000 }),
    totalUsd: fc.float({ min: 0, max: 1000, noNaN: true }),
    computeUsd: fc.float({ min: 0, max: 1000, noNaN: true }),
    volumeUsd: fc.float({ min: 0, max: 1000, noNaN: true }),
    snapshotUsd: fc.float({ min: 0, max: 1000, noNaN: true }),
  })
  .map((r) => r as SessionCost);

describe("aggregateFleetCost (fuzz)", () => {
  it("total is the same regardless of input order (within float tolerance)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(sessionArb, { minLength: 0, maxLength: 20 }), (sessions) => {
        const shuffled = [...sessions].reverse();
        const r1 = aggregateFleetCost(sessions, PRICING, NOW, NOW);
        const r2 = aggregateFleetCost(shuffled, PRICING, NOW, NOW);
        expect(Math.abs(r1.total.totalUsd - r2.total.totalUsd)).toBeLessThan(0.01);
      }),
    );
  });

  it("byUser sum equals fleet total (within float tolerance)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(sessionArb, { minLength: 0, maxLength: 20 }), (sessions) => {
        const report = aggregateFleetCost(sessions, PRICING, NOW, NOW);
        const userSum = report.byUser.reduce((s, u) => s + u.totalUsd, 0);
        expect(Math.abs(userSum - report.total.totalUsd)).toBeLessThan(0.01);
      }),
    );
  });

  it("bySession sum equals fleet total (within float tolerance)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(sessionArb, { minLength: 0, maxLength: 20 }), (sessions) => {
        const report = aggregateFleetCost(sessions, PRICING, NOW, NOW);
        const sessionSum = report.bySession.reduce((s, w) => s + w.totalUsd, 0);
        expect(Math.abs(sessionSum - report.total.totalUsd)).toBeLessThan(0.01);
      }),
    );
  });

  it("bySession is sorted most-expensive-first", () => {
    fc.assert(
      fc.property(fc.array(sessionArb, { minLength: 2, maxLength: 20 }), (sessions) => {
        const report = aggregateFleetCost(sessions, PRICING, NOW, NOW);
        for (let i = 1; i < report.bySession.length; i++) {
          const cur = report.bySession[i];
          const prev = report.bySession[i - 1];
          if (cur !== undefined && prev !== undefined) {
            expect(cur.totalUsd).toBeLessThanOrEqual(prev.totalUsd);
          }
        }
      }),
    );
  });
});
