// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { aggregateFleetCost, type SessionCost, type Pricing, type WorkspaceSizing } from "./cost";

const PRICING: Pricing = {
  fargateVcpuHourUsd: 0.04,
  fargateGbHourUsd: 0.004,
  ebsGbMonthUsd: 0.08,
  snapshotGbMonthUsd: 0.0125,
};

const SIZING: WorkspaceSizing = {
  vcpu: 0.5,
  memoryGib: 1,
  volumeGib: 20,
};

const NOW = "2026-01-01T00:00:00.000Z" as never;
const WINDOW_START = "2026-01-01T00:00:00.000Z" as never;

function makeSession(id: string, owner: string, totalUsd: number): SessionCost {
  return {
    workspaceId: id,
    owner,
    state: "running",
    terminated: false,
    runningMs: 1000,
    stoppedMs: 0,
    teardownMs: 0,
    totalUsd,
    computeUsd: totalUsd * 0.7,
    volumeUsd: totalUsd * 0.2,
    snapshotUsd: totalUsd * 0.1,
  };
}

describe("aggregateFleetCost (fuzz)", () => {
  it("total is the same regardless of input order", () => {
    const sessions = [
      makeSession("ws-3", "alice", 10.5),
      makeSession("ws-1", "bob", 5.2),
      makeSession("ws-2", "alice", 3.8),
      makeSession("ws-5", "carol", 0.1),
      makeSession("ws-4", "bob", 20.0),
    ];
    const shuffled = [...sessions].reverse();
    const r1 = aggregateFleetCost(sessions, PRICING, SIZING, NOW, WINDOW_START);
    const r2 = aggregateFleetCost(shuffled, PRICING, SIZING, NOW, WINDOW_START);
    expect(Math.abs(r1.total.totalUsd - r2.total.totalUsd)).toBeLessThan(0.001);
    expect(Math.abs(r1.total.computeUsd - r2.total.computeUsd)).toBeLessThan(0.001);
    expect(Math.abs(r1.total.volumeUsd - r2.total.volumeUsd)).toBeLessThan(0.001);
  });

  it("sum of byUser totals equals the fleet total", () => {
    const sessions = [
      makeSession("ws-1", "alice", 10.0),
      makeSession("ws-2", "alice", 5.0),
      makeSession("ws-3", "bob", 3.0),
    ];
    const report = aggregateFleetCost(sessions, PRICING, SIZING, NOW, WINDOW_START);
    const userSum = report.byUser.reduce((s, u) => s + u.totalUsd, 0);
    expect(Math.abs(userSum - report.total.totalUsd)).toBeLessThan(0.001);
  });

  it("sum of bySession totals equals the fleet total", () => {
    const sessions = [
      makeSession("ws-1", "alice", 10.0),
      makeSession("ws-2", "bob", 5.0),
      makeSession("ws-3", "carol", 3.0),
    ];
    const report = aggregateFleetCost(sessions, PRICING, SIZING, NOW, WINDOW_START);
    const sessionSum = report.bySession.reduce((s, w) => s + w.totalUsd, 0);
    expect(Math.abs(sessionSum - report.total.totalUsd)).toBeLessThan(0.001);
  });

  it("bySession is sorted most-expensive-first", () => {
    const sessions = [
      makeSession("ws-1", "alice", 1.0),
      makeSession("ws-2", "bob", 50.0),
      makeSession("ws-3", "carol", 5.0),
    ];
    const report = aggregateFleetCost(sessions, PRICING, SIZING, NOW, WINDOW_START);
    for (let i = 1; i < report.bySession.length; i++) {
      const cur = report.bySession[i];
      const prev = report.bySession[i - 1];
      if (cur !== undefined && prev !== undefined) {
        expect(cur.totalUsd).toBeLessThanOrEqual(prev.totalUsd);
      }
    }
  });

  it("byUser is sorted most-expensive-first", () => {
    const sessions = [
      makeSession("ws-1", "alice", 1.0),
      makeSession("ws-2", "bob", 50.0),
      makeSession("ws-3", "carol", 5.0),
    ];
    const report = aggregateFleetCost(sessions, PRICING, SIZING, NOW, WINDOW_START);
    for (let i = 1; i < report.byUser.length; i++) {
      const cur = report.byUser[i];
      const prev = report.byUser[i - 1];
      if (cur !== undefined && prev !== undefined) {
        expect(cur.totalUsd).toBeLessThanOrEqual(prev.totalUsd);
      }
    }
  });

  it("empty input produces zero total", () => {
    const report = aggregateFleetCost([], PRICING, SIZING, NOW, WINDOW_START);
    expect(report.total.totalUsd).toBe(0);
    expect(report.bySession).toEqual([]);
    expect(report.byUser).toEqual([]);
  });

  it("per-user session count is correct", () => {
    const sessions = [
      makeSession("ws-1", "alice", 1.0),
      makeSession("ws-2", "alice", 2.0),
      makeSession("ws-3", "alice", 3.0),
      makeSession("ws-4", "bob", 4.0),
    ];
    const report = aggregateFleetCost(sessions, PRICING, SIZING, NOW, WINDOW_START);
    const alice = report.byUser.find((u) => u.owner === "alice");
    const bob = report.byUser.find((u) => u.owner === "bob");
    expect(alice?.sessions ?? 0).toBe(3);
    expect(bob?.sessions ?? 0).toBe(1);
  });
});
