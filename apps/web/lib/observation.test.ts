// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { buildObservation, metric, type ObservationInput } from "./observation";

const runRate = {
  workspacesUsdPerHour: 0.5,
  controlPlaneUsdPerHour: 0.1,
  totalUsdPerHour: 0.6,
  workspacesUsdPerDay: 12,
  controlPlaneUsdPerDay: 2.4,
  totalUsdPerDay: 14.4,
};

function input(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    observedAt: new Date("2026-08-26T12:00:00.000Z"),
    health: { status: "ok", components: [{ component: "dynamodb", status: "ok" }] },
    cluster: {
      name: "edd-dev-workspaces",
      status: "ACTIVE",
      runningTasks: 2,
      pendingTasks: 0,
      activeServices: 1,
    },
    fleet: { total: 3, active: 2 },
    self: { memoryCurrentBytes: 100, memoryMaxBytes: 1000, ceilingHits: 0, socketThrottles: 0 },
    runRate,
    unpriced: [],
    ...overrides,
  };
}

// Shauth rejects a document whose totals disagree with its line items, whose
// daily is not hourly x 24, or whose exclusions are not exactly the five it
// requires. Those are the checks that make a published price meaningful, so
// they are asserted here rather than discovered on the operations page.
describe("cost estimate", () => {
  it("agrees with its line items and the pricing period", () => {
    const cost = buildObservation(input()).cost_estimate;
    const hourly = cost.line_items.reduce((sum, item) => sum + item.hourly, 0);
    const monthly = cost.line_items.reduce((sum, item) => sum + item.monthly, 0);
    expect(cost.hourly).toBeCloseTo(hourly, 9);
    expect(cost.monthly).toBeCloseTo(monthly, 9);
    expect(cost.daily).toBeCloseTo(cost.hourly * 24, 9);
    expect(cost.currency).toBe("USD");
    expect(cost.basis).toBe("public-on-demand");
    expect(cost.hours_per_month).toBeGreaterThan(0);
    expect([...cost.excludes].sort()).toEqual([
      "credits",
      "free_tier",
      "reservations",
      "savings_plans",
      "taxes",
    ]);
  });

  it("discloses what it could not price, naming the workspace", () => {
    const cost = buildObservation(
      input({ unpriced: [{ workspaceId: "ws-7", reason: "no structured resources" }] }),
    ).cost_estimate;
    expect(cost.limitations.some((l) => l.includes("ws-7"))).toBe(true);
    expect(cost.limitations.every((l) => l.trim().length > 0)).toBe(true);
  });

  it("always discloses at least one limitation", () => {
    // A price with nothing disclosed reads as complete when it is not — and the
    // contract rejects an empty list for exactly that reason.
    expect(buildObservation(input()).cost_estimate.limitations.length).toBeGreaterThan(0);
  });
});

describe("resources", () => {
  it("gives every resource a unique id, a kind and a valid health", () => {
    const { resources } = buildObservation(input());
    const ids = resources.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const resource of resources) {
      expect(resource.id).not.toBe("");
      expect(resource.kind).not.toBe("");
      expect(["healthy", "degraded", "unhealthy", "unknown"]).toContain(resource.health);
    }
  });

  // The whole reason this container reports its own cgroup: under cgroup v2 it
  // is throttled rather than killed, so it keeps serving and every other signal
  // stays green. Taking socket throttles has to show up as degraded.
  it("reports the container as degraded when it is taking socket throttles", () => {
    const observation = buildObservation(
      input({ self: { memoryCurrentBytes: 1, memoryMaxBytes: 2, ceilingHits: 12, socketThrottles: 900 } }),
    );
    const container = observation.resources.find((r) => r.id === "web-container");
    expect(container?.health).toBe("degraded");
  });

  it("reports the container as unknown when the counters cannot be read", () => {
    const observation = buildObservation(input({ self: {} }));
    const container = observation.resources.find((r) => r.id === "web-container");
    // Not "healthy": an unreadable counter is not evidence of health.
    expect(container?.health).toBe("unknown");
    const hits = container?.metrics.find((m) => m.name === "memory.ceiling_hits");
    expect(hits?.status).toBe("unavailable");
    expect(hits?.value).toBeUndefined();
  });
});

describe("metric", () => {
  it("publishes an unmeasurable value as unavailable, without a value", () => {
    expect(metric("m", "M", "bytes", undefined)).toEqual({
      name: "m",
      label: "M",
      unit: "bytes",
      status: "unavailable",
    });
  });

  it("keeps a real zero as an available reading", () => {
    // Zero is the healthy reading for a ceiling counter. Collapsing it into
    // "unavailable" would report a clean bill of health as unknown, and vice
    // versa — the distinction this whole document exists to preserve.
    expect(metric("m", "M", "events", 0)).toMatchObject({ status: "available", value: 0 });
  });

  it("throws rather than laundering a broken producer into unavailable", () => {
    expect(() => metric("m", "M", "events", Number.NaN)).toThrow(/non-representable/);
    expect(() => metric("m", "M", "events", -1)).toThrow(/non-representable/);
  });
});
