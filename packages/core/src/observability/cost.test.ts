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
  priceDurations,
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

  it("opens a teardown interval at the delete request (volume+snapshot keep billing)", () => {
    // session.delete is the delete REQUEST: compute stops but the volume + snapshot
    // bill on through teardown — the interval stays open to `now`, NOT terminated.
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.delete", 1)],
      at(10),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.teardown).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 10 * HOUR }]);
    expect(intervals.terminated).toBe(false);
  });

  it("bills the retained snapshot from teardown completion (session.terminated) until now", () => {
    // Teardown completion releases the volume but KEEPS the retained snapshot for
    // the undelete-retention window — snapshot GB-month accrues (as stopped time)
    // until session.purged/undelete, not $0 the moment teardown ends.
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.delete", 1), evt("session.terminated", 2)],
      at(10),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.teardown).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 2 * HOUR }]);
    expect(intervals.stopped).toEqual([{ fromMs: T0 + 2 * HOUR, toMs: T0 + 10 * HOUR }]);
    expect(intervals.terminated).toBe(true);
  });

  it("ends all billing at the retention purge (session.purged)", () => {
    const intervals = deriveBillingIntervals(
      [
        evt("session.create", 0),
        evt("session.delete", 1),
        evt("session.terminated", 2),
        evt("session.purged", 3),
      ],
      at(10),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.teardown).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 2 * HOUR }]);
    // Retention snapshot billed only until the purge removed it.
    expect(intervals.stopped).toEqual([{ fromMs: T0 + 2 * HOUR, toMs: T0 + 3 * HOUR }]);
    expect(intervals.terminated).toBe(true);
  });

  it("resumes billing after session.undelete (retention → stopped → wake)", () => {
    // A real production flow: delete → terminated → undelete (within retention) →
    // start. The old model broke the walk permanently at session.terminated, so
    // every post-undelete run was billed $0 forever.
    const intervals = deriveBillingIntervals(
      [
        evt("session.create", 0),
        evt("session.delete", 1),
        evt("session.terminated", 2),
        evt("session.undelete", 3),
        evt("session.start", 4),
      ],
      at(6),
    );
    expect(intervals.running).toEqual([
      { fromMs: T0, toMs: T0 + HOUR },
      { fromMs: T0 + 4 * HOUR, toMs: T0 + 6 * HOUR }, // post-undelete compute IS billed
    ]);
    expect(intervals.teardown).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 2 * HOUR }]);
    // Retention (2h→3h) + undeleted-stopped (3h→4h): the same snapshot, continuous.
    expect(intervals.stopped).toEqual([
      { fromMs: T0 + 2 * HOUR, toMs: T0 + 3 * HOUR },
      { fromMs: T0 + 3 * HOUR, toMs: T0 + 4 * HOUR },
    ]);
    expect(intervals.terminated).toBe(false); // undeleted — the session lives again
  });

  it("stops snapshot billing at session.snapshot_lost (the storage is gone)", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.stop", 1), evt("session.snapshot_lost", 2)],
      at(10),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.stopped).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 2 * HOUR }]);
    expect(intervals.terminated).toBe(false); // the (error-state) record survives
  });

  it("ends billing when the RETAINED snapshot is lost (nothing left to restore or bill)", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.terminated", 1), evt("session.snapshot_lost", 2)],
      at(10),
    );
    expect(intervals.stopped).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 2 * HOUR }]);
    expect(intervals.terminated).toBe(true);
  });

  it("ignores events timestamped after `now` (writer clock skew can't bill the future)", () => {
    // The same clamp walkBilling applies (`m <= throughMs`), keeping the full-scan
    // and checkpoint/resume paths equivalent under a skewed writer clock.
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.stop", 5)], // stop is 3h in the future
      at(2),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + 2 * HOUR }]);
    expect(intervals.stopped).toEqual([]);
  });

  it("ignores a start during teardown (a deleting workspace can't wake → no phantom compute)", () => {
    // session.delete opens teardown; a stray session.start must NOT reopen a running
    // interval (which would bill compute for a workspace being torn down).
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.delete", 1), evt("session.start", 2)],
      at(4),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + HOUR }]);
    expect(intervals.teardown).toEqual([{ fromMs: T0 + HOUR, toMs: T0 + 4 * HOUR }]);
    expect(intervals.terminated).toBe(false);
  });

  it("terminates directly from running when terminate arrives with no preceding delete", () => {
    const intervals = deriveBillingIntervals(
      [evt("session.create", 0), evt("session.terminated", 2)],
      at(10),
    );
    expect(intervals.running).toEqual([{ fromMs: T0, toMs: T0 + 2 * HOUR }]);
    expect(intervals.teardown).toEqual([]);
    // The retained snapshot bills through the retention window (as stopped time).
    expect(intervals.stopped).toEqual([{ fromMs: T0 + 2 * HOUR, toMs: T0 + 10 * HOUR }]);
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
      { running: [{ fromMs: T0, toMs: T0 + HOUR }], stopped: [], teardown: [], terminated: false },
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
      { running: [], stopped: [{ fromMs: T0, toMs: T0 + HOUR }], teardown: [], terminated: false },
      PRICING,
      SIZING,
    );
    expect(cost.computeUsd).toBe(0);
    expect(cost.volumeUsd).toBe(0);
    expect(cost.snapshotUsd).toBeCloseTo((1 / 730) * 8 * 0.05, 8);
    expect(cost.stoppedMs).toBe(HOUR);
  });

  it("prices a teardown hour as live volume + snapshot, no compute", () => {
    const cost = priceIntervals(
      { running: [], stopped: [], teardown: [{ fromMs: T0, toMs: T0 + HOUR }], terminated: false },
      PRICING,
      SIZING,
    );
    expect(cost.computeUsd).toBe(0);
    // The volume is still live AND a data-safety snapshot exists during teardown.
    expect(cost.volumeUsd).toBeCloseTo((1 / 730) * 8 * 0.08, 8);
    expect(cost.snapshotUsd).toBeCloseTo((1 / 730) * 8 * 0.05, 8);
    expect(cost.teardownMs).toBe(HOUR);
  });

  it("rejects non-finite inputs before they can render as NaN cost", () => {
    expect(() => priceDurations(Number.NaN, 0, 0, PRICING, SIZING)).toThrow(
      "runningMs must be a finite non-negative number",
    );
    expect(() =>
      priceDurations(0, 0, 0, { ...PRICING, fargateVcpuHourUsd: Number.NaN }, SIZING),
    ).toThrow("pricing.fargateVcpuHourUsd must be a finite non-negative number");
    expect(() => priceDurations(0, 0, 0, PRICING, { ...SIZING, volumeGib: Number.NaN })).toThrow(
      "sizing.volumeGib must be a finite positive number",
    );
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
          sizing: SIZING,
          state: "running",
          events: [evt("session.create", 0, "ws-1")],
        },
        // bob: one workspace running 1h then stopped 1h
        {
          workspaceId: "ws-2",
          owner: "bob",
          sizing: SIZING,
          state: "stopped",
          events: [evt("session.create", 0, "ws-2"), evt("session.stop", 1, "ws-2")],
        },
      ],
      PRICING,
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

  it("labels a workspace whose record is gone and teardown completed as terminated", () => {
    const report = computeFleetCost(
      [
        {
          workspaceId: "ws-9",
          owner: "carol",
          sizing: SIZING,
          events: [
            evt("session.create", 0, "ws-9"),
            evt("session.delete", 1, "ws-9"),
            evt("session.terminated", 1, "ws-9"),
          ],
        },
      ],
      PRICING,
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
      events: [
        evt("session.create", 0),
        evt("session.stop", 1),
        evt("session.delete", 2),
        evt("session.terminated", 3),
      ],
      nowH: 9,
    },
    {
      name: "teardown open",
      events: [evt("session.create", 0), evt("session.delete", 2)],
      nowH: 6,
    },
    {
      name: "idempotent start ignored",
      events: [evt("session.create", 0), evt("session.start", 1), evt("session.stop", 3)],
      nowH: 4,
    },
    {
      name: "retention open (terminated, not purged)",
      events: [evt("session.create", 0), evt("session.delete", 1), evt("session.terminated", 2)],
      nowH: 8,
    },
    {
      name: "undeleted and rewoken",
      events: [
        evt("session.create", 0),
        evt("session.delete", 1),
        evt("session.terminated", 2),
        evt("session.undelete", 3),
        evt("session.start", 4),
      ],
      nowH: 6,
    },
    {
      name: "purged",
      events: [
        evt("session.create", 0),
        evt("session.delete", 1),
        evt("session.terminated", 2),
        evt("session.purged", 3),
      ],
      nowH: 9,
    },
    {
      name: "snapshot lost while stopped",
      events: [evt("session.create", 0), evt("session.stop", 1), evt("session.snapshot_lost", 2)],
      nowH: 7,
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
        expect(resumed.teardownMs).toBe(sumMs(full.teardown));
      });
    }
  }

  // Sentinel: at least one scenario/checkpoint must exercise a NONZERO teardown amount,
  // so the teardownMs equivalence above isn't a vacuous 0===0 across the whole matrix.
  it("exercises a nonzero teardown amount (the teardown branch actually runs)", () => {
    const td = scenarios.flatMap((sc) =>
      [0, 0.5, 1, 1.5, 2, 2.5, 3, 4].map(
        (cpH) =>
          resumeBilling(deriveBillingState(sc.events, at(cpH)), at(cpH), sc.events, at(sc.nowH))
            .teardownMs,
      ),
    );
    expect(Math.max(...td)).toBeGreaterThan(0);
  });
});

describe("clipIntervals", () => {
  it("keeps only the part of each interval inside the window", () => {
    const clipped = clipIntervals(
      {
        running: [{ fromMs: T0, toMs: T0 + 4 * HOUR }],
        stopped: [],
        teardown: [],
        terminated: false,
      },
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
        teardown: [],
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
      sizing: SIZING,
      state: "running",
      events: [evt("session.create", 60, "ws-recent")], // started 12h before NOW, still running
    },
    {
      workspaceId: "ws-purged",
      owner: "bob",
      sizing: SIZING,
      state: "deleted",
      // Fully ended early (terminated AND purged) — no in-window activity at all.
      events: [
        evt("session.create", 0, "ws-purged"),
        evt("session.delete", 2, "ws-purged"),
        evt("session.terminated", 2, "ws-purged"),
        evt("session.purged", 4, "ws-purged"),
      ],
    },
    {
      workspaceId: "ws-retained",
      owner: "carol",
      sizing: SIZING,
      state: "terminated",
      // Terminated early but never purged: its retained snapshot still exists —
      // and bills — through the window.
      events: [
        evt("session.create", 0, "ws-retained"),
        evt("session.delete", 2, "ws-retained"),
        evt("session.terminated", 2, "ws-retained"),
      ],
    },
  ];

  it("prices only in-window time and drops sessions with none (a purged one)", () => {
    const report = computeFleetCost(inputs, PRICING, NOW, relativeWindow(NOW, 1));
    expect(report.bySession.map((s) => s.workspaceId).sort()).toEqual(["ws-recent", "ws-retained"]);
    const recent = report.bySession.find((s) => s.workspaceId === "ws-recent");
    expect(recent?.runningMs).toBe(12 * HOUR); // clipped to the last day
    // The retained snapshot billed for the whole in-window day (stopped time).
    const retained = report.bySession.find((s) => s.workspaceId === "ws-retained");
    expect(retained?.stoppedMs).toBe(24 * HOUR);
    expect(report.byUser.map((u) => u.owner).sort()).toEqual(["alice", "carol"]);
    expect(report.windowStart).toBe(at(48));
  });

  it("without a window prices the full lifetime (windowStart = earliest event)", () => {
    const report = computeFleetCost(inputs, PRICING, NOW);
    expect(report.bySession.map((s) => s.workspaceId).sort()).toEqual([
      "ws-purged",
      "ws-recent",
      "ws-retained",
    ]);
    expect(report.windowStart).toBe(at(0));
  });
});
