// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  HOUR_MS as HOUR,
  T0_MS as T0,
  TEST_PRICING as PRICING,
  TEST_SIZING as SIZING,
  atHours as at,
  costEvent as evt,
} from "./cost-fixtures";
import {
  clipIntervals,
  computeFleetCost,
  deriveBillingIntervals,
  deriveBillingState,
  priceIntervals,
  relativeWindow,
  resumeBilling,
} from "./cost";

import type { AuditEvent } from "./audit";

const DAY = 24 * HOUR;

describe("deriveBillingIntervals", () => {
  it("treats create as the start of a running interval, open to `now`", () => {
    const intervals = deriveBillingIntervals([evt("session.create", 0)], at(2));
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + 2 * HOUR }]);
    expect(intervals.stopped).toEqual([]);
    expect(intervals.terminated).toBe(false);
  });

  it("splits a create→stop sequence into a running then a stopped interval", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.stop", 1)],
      at(3),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.stopped).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 3 * HOUR }]);
  });

  it("reconstructs a full create→stop→wake→stop cycle", () => {
    const intervals = deriveBillingIntervals(
      [
        evt("session.create", 0),
        evt("session.stop", 1),
        evt("session.start", 2),
        evt("session.stop", 3),
      ],
      at(5),
    );
    expect(intervals.running).toEqual([
      { fromMs: T0, toMs: T0 + HOUR },
      { fromMs: T0 + 2 * HOUR, toMs: T0 + 3 * HOUR },
    ]);
    expect(intervals.stopped).toEqual([
      { fromMs: T0 + HOUR, toMs: T0 + 2 * HOUR },
      { fromMs: T0 + 3 * HOUR, toMs: T0 + 5 * HOUR },
    ]);
  });

  it("ends all billing at delete (no interval left open to `now`)", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.delete", 1)],
      at(10),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.stopped).toEqual([]);
    expect(intervals.terminated).toBe(true);
  });

  it("ignores an idempotent repeated start (no double-open)", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.start", 1), evt("session.start", 2)],
      at(4),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + 4 * HOUR }]);
  });

  it("sorts events given out of order", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.stop", 1), evt("session.create", 0)],
      at(2),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
  });

  it("ignores non-lifecycle actions", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("repo.create", 1)],
      at(2),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + 2 * HOUR }]);
    expect(intervals.stopped).toEqual([]);
  });
});

describe("priceIntervals", () => {
  it("prices one running hour as Fargate compute + a live-volume slice", () => {
    const cost = priceIntervals(
      { running: [{ fromMs: T0, toMs: T0 + HOUR }], stopped: [], terminated: false },
      PRICING,
      SIZING,
    );
    // compute = 0.5*0.04048 + 1*0.004445
    expect(cost.computeUsd).toBeCloseTo(0.024685, 6);
    // volume = (1/730) * 8 GiB * $0.08/GiB-month
    expect(cost.volumeUsd).toBeCloseTo((1 / 730) * 8 * 0.08, 8);
    expect(cost.snapshotUsd).toBe(0);
    expect(cost.totalUsd).toBeCloseTo(cost.computeUsd + cost.volumeUsd, 8);
    expect(cost.runningMs).toBe(HOUR);
  });

  it("prices a stopped hour as snapshot storage only (no compute, no live volume)", () => {
    const cost = priceIntervals(
      { running: [], stopped: [{ fromMs: T0, toMs: T0 + HOUR }], terminated: false },
      PRICING,
      SIZING,
    );
    expect(cost.computeUsd).toBe(0);
    expect(cost.volumeUsd).toBe(0);
    expect(cost.snapshotUsd).toBeCloseTo((1 / 730) * 8 * 0.05, 8);
    expect(cost.stoppedMs).toBe(HOUR);
  });
});

describe("computeFleetCost", () => {
  it("rolls up per-session and per-user, fleet total, most-expensive first", () => {
    const report = computeFleetCost(
      [
        // alice: one workspace running 2h
        {
          workspaceId: "ws-1",
          owner: "alice",
          state: "running",
          events: [evt("session.create", 0, "ws-1")],
        },
        // bob: one workspace running 1h then stopped 1h
        {
          workspaceId: "ws-2",
          owner: "bob",
          state: "stopped",
          events: [evt("session.create", 0, "ws-2"), evt("session.stop", 1, "ws-2")],
        },
      ],
      PRICING,
      SIZING,
      at(2),
    );

    expect(report.bySession).toHaveLength(2);
    expect(report.byUser).toHaveLength(2);
    // alice ran 2h of compute, bob 1h — alice costs more, sorted first.
    expect(report.byUser[0]?.owner).toBe("alice");
    expect(report.bySession[0]?.workspaceId).toBe("ws-1");
    // fleet total = sum of the two sessions.
    const sessionsTotal = report.bySession.reduce((s, x) => s + x.totalUsd, 0);
    expect(report.total.totalUsd).toBeCloseTo(sessionsTotal, 10);
    expect(report.byUser[0]?.sessions).toBe(1);
    // window start is the earliest event (T0), not `now`.
    expect(report.windowStart).toBe(at(0));
    expect(report.generatedAt).toBe(at(2));
  });

  it("labels a workspace whose record is gone but had a delete as terminated", () => {
    const report = computeFleetCost(
      [
        {
          workspaceId: "ws-9",
          owner: "carol",
          events: [evt("session.create", 0, "ws-9"), evt("session.delete", 1, "ws-9")],
        },
      ],
      PRICING,
      SIZING,
      at(5),
    );
    expect(report.bySession[0]?.state).toBe("terminated");
    expect(report.bySession[0]?.terminated).toBe(true);
  });
});

describe("deriveBillingState + resumeBilling (rollup figure-equivalence)", () => {
  const sumMs = (ints: readonly { fromMs: number; toMs: number }[]): number =>
    ints.reduce((s, i) => s + (i.toMs - i.fromMs), 0);

  const scenarios: { name: string; events: AuditEvent[]; nowH: number }[] = [
    { name: "running open", events: [evt("session.create", 0)], nowH: 5 },
    { name: "create-stop", events: [evt("session.create", 0), evt("session.stop", 2)], nowH: 6 },
    {
      name: "full cycle",
      events: [
        evt("session.create", 0),
        evt("session.stop", 1),
        evt("session.start", 2),
        evt("session.stop", 3),
      ],
      nowH: 5,
    },
    {
      name: "wake open",
      events: [evt("session.create", 0), evt("session.stop", 1), evt("session.start", 2)],
      nowH: 7,
    },
    {
      name: "terminated",
      events: [evt("session.create", 0), evt("session.stop", 1), evt("session.delete", 2)],
      nowH: 9,
    },
    {
      name: "idempotent start ignored",
      events: [evt("session.create", 0), evt("session.start", 1), evt("session.stop", 3)],
      nowH: 4,
    },
  ];

  // A rollup checkpointed at ANY instant, then resumed with the remaining events,
  // must price identically to deriving the whole ledger at `now` — the invariant
  // the cost rollup relies on so figures never change.
  for (const sc of scenarios) {
    for (const cpH of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]) {
      it(`${sc.name}: checkpoint h=${String(cpH)} == full-scan h=${String(sc.nowH)}`, () => {
        const full = deriveBillingIntervals(sc.events, at(sc.nowH));
        const state = deriveBillingState(sc.events, at(cpH));
        const resumed = resumeBilling(state, at(cpH), sc.events, at(sc.nowH));
        expect(resumed.runningMs).toBe(sumMs(full.running));
        expect(resumed.stoppedMs).toBe(sumMs(full.stopped));
      });
    }
  }
});

describe("clipIntervals", () => {
  it("keeps only the part of each interval inside the window", () => {
    const clipped = clipIntervals(
      { running: [{ fromMs: T0, toMs: T0 + 4 * HOUR }], stopped: [], terminated: false },
      { fromMs: T0 + HOUR, toMs: T0 + 3 * HOUR },
    );
    expect(clipped.running).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 3 * HOUR }]);
    expect(clipped.stopped).toEqual([]);
  });

  it("drops intervals entirely outside the window and preserves `terminated`", () => {
    const clipped = clipIntervals(
      {
        running: [{ fromMs: T0, toMs: T0 + HOUR }],
        stopped: [{ fromMs: T0 + 5 * HOUR, toMs: T0 + 6 * HOUR }],
        terminated: true,
      },
      { fromMs: T0 + 2 * HOUR, toMs: T0 + 4 * HOUR },
    );
    expect(clipped.running).toEqual([]);
    expect(clipped.stopped).toEqual([]);
    expect(clipped.terminated).toBe(true);
  });
});

describe("relativeWindow", () => {
  it("spans [now - days, now)", () => {
    expect(relativeWindow(at(48), 1)).toEqual({ fromMs: T0 + DAY, toMs: T0 + 2 * DAY });
  });
});

describe("computeFleetCost windowing", () => {
  const NOW = at(72); // 3 days after T0
  const inputs = [
    {
      workspaceId: "ws-recent",
      owner: "alice",
      state: "running",
      events: [evt("session.create", 60, "ws-recent")], // started 12h before NOW, still running
    },
    {
      workspaceId: "ws-old",
      owner: "bob",
      state: "deleted",
      events: [evt("session.create", 0, "ws-old"), evt("session.delete", 2, "ws-old")],
    },
  ];

  it("prices only in-window run-time and drops sessions inactive in the window", () => {
    const report = computeFleetCost(inputs, PRICING, SIZING, NOW, relativeWindow(NOW, 1));
    expect(report.bySession.map((s) => s.workspaceId)).toEqual(["ws-recent"]);
    expect(report.bySession[0]?.runningMs).toBe(12 * HOUR); // clipped to the last day
    expect(report.byUser.map((u) => u.owner)).toEqual(["alice"]);
    expect(report.windowStart).toBe(at(48));
  });

  it("without a window prices the full lifetime (windowStart = earliest event)", () => {
    const report = computeFleetCost(inputs, PRICING, SIZING, NOW);
    expect(report.bySession.map((s) => s.workspaceId).sort()).toEqual(["ws-old", "ws-recent"]);
    expect(report.windowStart).toBe(at(0));
  });
});
