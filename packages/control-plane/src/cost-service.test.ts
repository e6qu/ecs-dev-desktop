// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import { workspacePricing, workspaceSizing } from "@edd/config";
import { isoTimestamp, type AuditEvent, type Clock } from "@edd/core";
import { describe, expect, it } from "vitest";

import { CostService, type CostRollupRecord, type CostRollupStore } from "./cost-service";

// The real @edd/config defaults (us-east-1 on-demand; 0.5 vCPU / 1 GiB / 8 GiB),
// so the service test is pinned to the rates the app actually charges.
const PRICING = workspacePricing();
const SIZING = workspaceSizing();

const hoursMs = (h: number) => h * 3_600_000;
const epoch = Date.parse("2026-03-01T00:00:00.000Z");
const at = (h: number) => isoTimestamp(new Date(epoch + hoursMs(h)).toISOString());
const NOW = at(4);
const clock: Clock = { now: () => NOW };

const evt = (action: string, h: number, target: string, actor: string): AuditEvent => ({
  action,
  at: at(h),
  actor,
  target,
  detail: "",
});

const dto = (id: string, ownerId: string, state: WorkspaceDto["state"]): WorkspaceDto => ({
  id,
  ownerId,
  baseImage: "golden/node:20",
  state,
  createdAt: at(0),
  availableActions: [],
});

function service(events: AuditEvent[], workspaces: WorkspaceDto[]): CostService {
  return new CostService({
    audit: {
      all: () => Promise.resolve(events),
      since: (from: string) => Promise.resolve(events.filter((e) => e.at.localeCompare(from) > 0)),
    },
    workspaces: { list: () => Promise.resolve(workspaces) },
    clock,
    pricing: PRICING,
    sizing: SIZING,
  });
}

describe("CostService.report", () => {
  it("prices a workspace from its lifecycle ledger, attributing the creator's email", async () => {
    const report = await service(
      [evt("session.create", 0, "ws-1", "alice@example.com")],
      [dto("ws-1", "alice", "running")],
    ).report();

    expect(report.bySession).toHaveLength(1);
    const s = report.bySession[0];
    expect(s?.workspaceId).toBe("ws-1");
    // Owner comes from the session.create actor (the email), not the record id.
    expect(s?.owner).toBe("alice@example.com");
    expect(s?.state).toBe("running");
    // Ran 4h (create → now); compute = 4 * (0.5*0.04048 + 1*0.004445).
    expect(s?.computeUsd).toBeCloseTo(4 * 0.024685, 6);
    expect(report.total.totalUsd).toBeCloseTo(s?.totalUsd ?? 0, 10);
  });

  it("excludes non-session actions (repo.create forms no cost line)", async () => {
    const report = await service(
      [
        evt("session.create", 0, "ws-1", "alice@example.com"),
        evt("repo.create", 1, "alice/myrepo", "alice@example.com"),
      ],
      [dto("ws-1", "alice", "running")],
    ).report();
    expect(report.bySession.map((s) => s.workspaceId)).toEqual(["ws-1"]);
  });

  it("includes a workspace that has a record but no ledger events (zero cost, owner from record)", async () => {
    const report = await service([], [dto("ws-old", "bob", "idle")]).report();
    expect(report.bySession).toHaveLength(1);
    expect(report.bySession[0]?.owner).toBe("bob");
    expect(report.bySession[0]?.totalUsd).toBe(0);
  });

  it("still prices a deleted workspace (record gone) from its retained ledger", async () => {
    const report = await service(
      [
        evt("session.create", 0, "ws-gone", "carol@example.com"),
        evt("session.delete", 2, "ws-gone", "carol@example.com"),
        evt("session.terminated", 2, "ws-gone", "carol@example.com"),
      ],
      [], // record already removed
    ).report();
    expect(report.bySession).toHaveLength(1);
    expect(report.bySession[0]?.state).toBe("terminated");
    expect(report.bySession[0]?.owner).toBe("carol@example.com");
    expect(report.bySession[0]?.computeUsd).toBeGreaterThan(0);
  });
});

describe("CostService.report windowing", () => {
  const DAY = 24 * 3_600_000;
  const day = (d: number) => isoTimestamp(new Date(epoch + d * DAY).toISOString());
  const NOW = day(10);
  const winClock: Clock = { now: () => NOW };
  const ev = (action: string, d: number, target: string): AuditEvent => ({
    action,
    at: day(d),
    actor: target,
    target,
    detail: "",
  });

  function winService(events: AuditEvent[], workspaces: WorkspaceDto[]): CostService {
    return new CostService({
      audit: {
        all: () => Promise.resolve(events),
        since: (from: string) =>
          Promise.resolve(events.filter((e) => e.at.localeCompare(from) > 0)),
      },
      workspaces: { list: () => Promise.resolve(workspaces) },
      clock: winClock,
      pricing: PRICING,
      sizing: SIZING,
    });
  }

  // An old (days 0-1) session, fully torn down early, and a recent (day 9 → still
  // running at day 10) one.
  const events: AuditEvent[] = [
    ev("session.create", 0, "ws-old"),
    ev("session.delete", 1, "ws-old"),
    ev("session.terminated", 1, "ws-old"),
    ev("session.create", 9, "ws-recent"),
  ];
  const workspaces = [dto("ws-recent", "alice", "running")]; // ws-old's record is gone

  it("limits the report to the last N days, dropping sessions inactive in the window", async () => {
    const report = await winService(events, workspaces).report(7); // last 7 days
    expect(report.bySession.map((s) => s.workspaceId)).toEqual(["ws-recent"]);
    expect(report.bySession[0]?.runningMs).toBe(DAY); // day 9 → now (day 10), clipped to window
    expect(report.windowStart).toBe(day(3)); // now - 7 days
  });

  it("prices the full lifetime when no window is given", async () => {
    const report = await winService(events, workspaces).report();
    expect(report.bySession.map((s) => s.workspaceId).sort()).toEqual(["ws-old", "ws-recent"]);
    expect(report.windowStart).toBe(day(0)); // earliest event
  });
});

describe("CostService.rollupIfStale", () => {
  const events = [evt("session.create", 0, "ws-r", "alice@example.com")];

  function fakeStore(initial: CostRollupRecord[] = []) {
    let records = [...initial];
    const store: CostRollupStore = {
      list: () => Promise.resolve(records),
      replaceAll: (next) => {
        records = [...next];
        return Promise.resolve();
      },
    };
    return {
      store,
      get records() {
        return records;
      },
    };
  }

  function svc(nowIso: string, store: CostRollupStore): CostService {
    return new CostService({
      audit: {
        all: () => Promise.resolve(events),
        since: (from: string) =>
          Promise.resolve(events.filter((e) => e.at.localeCompare(from) > 0)),
      },
      workspaces: { list: () => Promise.resolve([]) },
      clock: { now: () => isoTimestamp(nowIso) },
      pricing: PRICING,
      sizing: SIZING,
      rollups: store,
    });
  }

  const checkpoint = (checkpointAt: string): CostRollupRecord => ({
    workspaceId: "ws-r",
    owner: "alice@example.com",
    checkpointAt,
    windowStart: at(0),
    runningMs: 0,
    stoppedMs: 0,
    teardownMs: 0,
    phase: "running",
  });

  it("regenerates the checkpoints when none exist", async () => {
    const f = fakeStore([]);
    await svc(at(4), f.store).rollupIfStale(2 * 3_600_000);
    expect(f.records.length).toBeGreaterThan(0);
    expect(f.records[0]?.checkpointAt).toBe(at(4));
  });

  it("no-ops when the newest checkpoint is within the cadence", async () => {
    const f = fakeStore([checkpoint(at(3.5))]); // 0.5h old at now=4h
    await svc(at(4), f.store).rollupIfStale(2 * 3_600_000); // 2h cadence → fresh
    expect(f.records[0]?.checkpointAt).toBe(at(3.5)); // untouched
  });

  it("regenerates when the newest checkpoint is older than the cadence", async () => {
    const f = fakeStore([checkpoint(at(0))]); // 4h old at now=4h
    await svc(at(4), f.store).rollupIfStale(1 * 3_600_000); // 1h cadence → stale
    expect(f.records[0]?.checkpointAt).toBe(at(4)); // regenerated to now
  });
});
