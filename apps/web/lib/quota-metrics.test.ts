// SPDX-License-Identifier: AGPL-3.0-or-later
import { InMemoryMetricSink, METRIC_QUOTA_DENIED, METRIC_QUOTA_UTILIZATION } from "@edd/core";
import { describe, expect, it } from "vitest";

import { recordQuotaUsage } from "./quota-metrics";

describe("recordQuotaUsage", () => {
  it("emits the utilization gauge dimensioned by role, no denial when allowed", () => {
    const m = new InMemoryMetricSink();
    recordQuotaUsage(m, { owned: 3, limit: 5, role: "developer", allowed: true });

    expect(m.recorded).toEqual([
      {
        kind: "gauge",
        name: METRIC_QUOTA_UTILIZATION,
        value: 0.6,
        dimensions: { role: "developer" },
      },
    ]);
  });

  it("emits 0 utilization for an unlimited role (null limit)", () => {
    const m = new InMemoryMetricSink();
    recordQuotaUsage(m, { owned: 12, limit: null, role: "admin", allowed: true });

    expect(m.recorded).toEqual([
      { kind: "gauge", name: METRIC_QUOTA_UTILIZATION, value: 0, dimensions: { role: "admin" } },
    ]);
  });

  it("emits a denial count alongside the gauge when the quota is reached", () => {
    const m = new InMemoryMetricSink();
    recordQuotaUsage(m, { owned: 5, limit: 5, role: "viewer", allowed: false });

    expect(m.recorded).toContainEqual({
      kind: "gauge",
      name: METRIC_QUOTA_UTILIZATION,
      value: 1,
      dimensions: { role: "viewer" },
    });
    expect(m.recorded).toContainEqual({
      kind: "count",
      name: METRIC_QUOTA_DENIED,
      value: 1,
      dimensions: { role: "viewer" },
    });
  });
});
