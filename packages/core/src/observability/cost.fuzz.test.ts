// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the cost model. The headline is the
// figure-equivalence invariant the rollup relies on: pricing from a persisted
// checkpoint + the events since it must equal pricing the whole ledger — for ANY
// event stream and ANY checkpoint instant (including one exactly on an event). Also
// pins interval non-negativity, order-independence, clip idempotence/bounds, pricing
// linearity, and the relativeWindow fail-loud guard.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isoTimestamp, type IsoTimestamp } from "../domain/ids";
import type { AuditEvent } from "./audit";
import {
  clipIntervals,
  deriveBillingIntervals,
  deriveBillingState,
  priceDurations,
  priceIntervals,
  relativeWindow,
  resumeBilling,
  type BillingIntervals,
  type Interval,
  type Pricing,
  type WorkspaceSizing,
} from "./cost";

const ACTIONS = [
  "session.create",
  "session.start",
  "session.stop",
  "session.delete",
  "session.terminated",
  "session.undelete",
  "session.purged",
  "session.snapshot_lost",
  "session.snapshot", // a no-op for billing — exercises the "ignore unknown action" path
];
const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number): IsoTimestamp => isoTimestamp(new Date(ms).toISOString());
const sum = (xs: readonly Interval[]): number => xs.reduce((a, i) => a + (i.toMs - i.fromMs), 0);

const PRICING: Pricing = {
  fargateVcpuHourUsd: 0.04,
  fargateGbHourUsd: 0.004,
  ebsGbMonthUsd: 0.08,
  snapshotGbMonthUsd: 0.05,
};
const SIZING: WorkspaceSizing = { vcpu: 1, memoryGib: 2, volumeGib: 30 };

/** A chronological lifecycle event stream + a `now` at/after the last event.
 * `minGap` is the smallest inter-event gap: 0 allows two events at the SAME instant
 * (whose relative order is causally meaningful — `stop` then `start` ≠ `start` then
 * `stop` at one ms); ≥1 forces strictly-increasing, chronologically-unambiguous
 * instants (the precondition for order-independence). */
const makeStreamArb = (minGap: number) =>
  fc
    .record({
      steps: fc.array(
        fc.record({
          gap: fc.integer({ min: minGap, max: 200_000 }),
          action: fc.constantFrom(...ACTIONS),
        }),
        { minLength: 0, maxLength: 14 },
      ),
      tail: fc.integer({ min: 0, max: 200_000 }),
      // Optionally one event slightly AFTER `now` (a skewed writer clock): every
      // derivation must ignore it — and both walk paths must ignore it IDENTICALLY,
      // or the full scan and the checkpoint/resume would report different figures.
      future: fc.option(
        fc.record({
          gap: fc.integer({ min: 1, max: 100_000 }),
          action: fc.constantFrom(...ACTIONS),
        }),
        { nil: undefined },
      ),
    })
    .map(({ steps, tail, future }) => {
      let t = BASE;
      const events: AuditEvent[] = [];
      const times: number[] = [];
      for (const { gap, action } of steps) {
        t += gap;
        times.push(t);
        events.push({ at: iso(t), actor: "system", action, target: "ws-x", detail: "" });
      }
      const nowMs = t + tail;
      if (future !== undefined) {
        events.push({
          at: iso(nowMs + future.gap),
          actor: "system",
          action: future.action,
          target: "ws-x",
          detail: "",
        });
      }
      return { events, times, nowMs, now: iso(nowMs) };
    });

const streamArb = makeStreamArb(0);
/** Strictly-increasing instants — every event at a distinct ms, so the chronological
 * order is unambiguous (required for the order-independence property). */
const distinctStreamArb = makeStreamArb(1);

describe("cost model — properties", () => {
  it("checkpoint + resume equals full-ledger derivation (figure equivalence) for any split", () => {
    fc.assert(
      fc.property(streamArb, fc.double({ min: 0, max: 1, noNaN: true }), (s, frac) => {
        // Draw the checkpoint anywhere in [BASE, now] — biased to land exactly on event
        // instants (the boundary case where an inclusive/exclusive off-by-one would show).
        const candidates = [BASE, s.nowMs, ...s.times];
        const cpMs =
          candidates[Math.min(candidates.length - 1, Math.floor(frac * candidates.length))] ??
          s.nowMs;
        const cp = iso(cpMs);
        const before = s.events.filter((e) => Date.parse(e.at) <= cpMs);
        const after = s.events.filter((e) => Date.parse(e.at) > cpMs);

        const resumed = resumeBilling(deriveBillingState(before, cp), cp, after, s.now);
        const full = deriveBillingIntervals(s.events, s.now);

        expect(resumed.runningMs).toBeCloseTo(sum(full.running), 6);
        expect(resumed.stoppedMs).toBeCloseTo(sum(full.stopped), 6);
        expect(resumed.teardownMs).toBeCloseTo(sum(full.teardown), 6);
        expect(resumed.terminated).toBe(full.terminated);
      }),
    );
  });

  it("derived intervals are non-negative (any stream, incl. same-instant events)", () => {
    fc.assert(
      fc.property(streamArb, (s) => {
        const intervals = deriveBillingIntervals(s.events, s.now);
        for (const bucket of [intervals.running, intervals.stopped, intervals.teardown]) {
          for (const i of bucket) expect(i.toMs).toBeGreaterThanOrEqual(i.fromMs);
        }
      }),
    );
  });

  it("is order-independent for a chronologically-unambiguous (distinct-instant) stream", () => {
    fc.assert(
      // Reversing the input must not change the output — but ONLY when instants are
      // distinct. At the same ms the event order is causally meaningful (the internal
      // sort is stable, so it preserves the ledger's read order for ties), so reversing
      // a same-instant stream legitimately changes the bill. Use distinct instants.
      fc.property(distinctStreamArb, (s) => {
        const intervals = deriveBillingIntervals(s.events, s.now);
        const reversed = deriveBillingIntervals([...s.events].reverse(), s.now);
        expect(sum(reversed.running)).toBeCloseTo(sum(intervals.running), 6);
        expect(sum(reversed.stopped)).toBeCloseTo(sum(intervals.stopped), 6);
        expect(sum(reversed.teardown)).toBeCloseTo(sum(intervals.teardown), 6);
      }),
    );
  });

  it("clipping is bounded and idempotent", () => {
    const windowArb = fc
      .tuple(fc.integer({ min: BASE - 1e9, max: BASE + 1e9 }), fc.integer({ min: 0, max: 2e9 }))
      .map(([from, span]): Interval => ({ fromMs: from, toMs: from + span }));
    fc.assert(
      fc.property(streamArb, windowArb, (s, window) => {
        const intervals = deriveBillingIntervals(s.events, s.now);
        const clipped = clipIntervals(intervals, window);
        // Bounded: clipping never increases total duration in any bucket.
        expect(sum(clipped.running)).toBeLessThanOrEqual(sum(intervals.running) + 1e-6);
        expect(sum(clipped.stopped)).toBeLessThanOrEqual(sum(intervals.stopped) + 1e-6);
        // Idempotent: clipping the clipped result by the same window is a fixpoint.
        const twice = clipIntervals(clipped, window);
        expect(sum(twice.running)).toBeCloseTo(sum(clipped.running), 6);
        expect(twice.terminated).toBe(intervals.terminated);
      }),
    );
  });

  it("priceDurations is linear, non-negative, and totals exactly", () => {
    const durArb = fc.record({
      r: fc.integer({ min: 0, max: 30 * 86_400_000 }),
      s: fc.integer({ min: 0, max: 30 * 86_400_000 }),
      t: fc.integer({ min: 0, max: 86_400_000 }),
    });
    fc.assert(
      fc.property(durArb, (d) => {
        const c = priceDurations(d.r, d.s, d.t, PRICING, SIZING);
        expect(c.computeUsd).toBeGreaterThanOrEqual(0);
        expect(c.volumeUsd).toBeGreaterThanOrEqual(0);
        expect(c.snapshotUsd).toBeGreaterThanOrEqual(0);
        expect(c.totalUsd).toBeCloseTo(c.computeUsd + c.volumeUsd + c.snapshotUsd, 9);
        // Doubling every duration doubles every cost component (linearity).
        const c2 = priceDurations(d.r * 2, d.s * 2, d.t * 2, PRICING, SIZING);
        expect(c2.totalUsd).toBeCloseTo(c.totalUsd * 2, 6);
      }),
    );
  });

  it("priceIntervals equals priceDurations of the interval totals", () => {
    fc.assert(
      fc.property(streamArb, (s) => {
        const intervals: BillingIntervals = deriveBillingIntervals(s.events, s.now);
        const viaIntervals = priceIntervals(intervals, PRICING, SIZING);
        const viaDurations = priceDurations(
          sum(intervals.running),
          sum(intervals.stopped),
          sum(intervals.teardown),
          PRICING,
          SIZING,
        );
        expect(viaIntervals.totalUsd).toBeCloseTo(viaDurations.totalUsd, 9);
      }),
    );
  });

  it("relativeWindow fails loud on non-positive / non-finite days, and spans exactly `days`", () => {
    const now = iso(BASE);
    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => relativeWindow(now, bad)).toThrow();
    }
    fc.assert(
      fc.property(fc.double({ min: Math.fround(0.001), max: 3650, noNaN: true }), (days) => {
        const w = relativeWindow(now, days);
        expect(w.toMs).toBeGreaterThan(w.fromMs);
        expect(w.toMs - w.fromMs).toBeCloseTo(days * 86_400_000, 3);
      }),
    );
  });
});
