// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { InMemoryMetricSink, NoopMetricSink, type MetricSink } from "./metrics";

describe("InMemoryMetricSink", () => {
  it("records counts (default 1), gauges, and timings with dimensions", () => {
    const m = new InMemoryMetricSink();
    m.count("a");
    m.count("a", 3, { region: "us-east-1" });
    m.gauge("fleet", 12);
    m.timing("wake", 250, { baseImage: "node" });

    expect(m.recorded).toEqual([
      { kind: "count", name: "a", value: 1 },
      { kind: "count", name: "a", value: 3, dimensions: { region: "us-east-1" } },
      { kind: "gauge", name: "fleet", value: 12 },
      { kind: "timing", name: "wake", value: 250, dimensions: { baseImage: "node" } },
    ]);
  });
});

describe("NoopMetricSink", () => {
  it("accepts every call without throwing", () => {
    const m: MetricSink = new NoopMetricSink();
    expect(() => {
      m.count("a");
      m.gauge("b", 1);
      m.timing("c", 1);
    }).not.toThrow();
  });
});
