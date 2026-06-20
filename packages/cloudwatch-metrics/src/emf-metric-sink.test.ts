// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixedClock } from "@edd/core";
import { describe, expect, it } from "vitest";

import { buildEmfDocument, EmfMetricSink } from "./emf-metric-sink";

const AT = "2026-06-01T00:00:00.000Z";

describe("buildEmfDocument", () => {
  it("encodes namespace, dimensions, unit, value, and timestamp", () => {
    const doc = buildEmfDocument(
      "workspace.wake.latency_ms",
      1234,
      "Milliseconds",
      Date.parse(AT),
      "edd/control-plane",
      { baseImage: "node" },
    );

    expect(doc._aws.Timestamp).toBe(Date.parse(AT));
    const cwm = doc._aws.CloudWatchMetrics[0];
    expect(cwm?.Namespace).toBe("edd/control-plane");
    expect(cwm?.Dimensions).toEqual([["baseImage"]]);
    expect(cwm?.Metrics[0]).toEqual({ Name: "workspace.wake.latency_ms", Unit: "Milliseconds" });
    // The metric value and each dimension are top-level members keyed by name.
    expect(doc["workspace.wake.latency_ms"]).toBe(1234);
    expect(doc.baseImage).toBe("node");
  });

  it("emits an empty dimension set when there are no dimensions", () => {
    const doc = buildEmfDocument("reconciler.sweep.count", 1, "Count", Date.parse(AT), "ns", {});
    expect(doc._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
  });

  it("throws if a dimension key collides with the metric name or `_aws`", () => {
    const at = Date.parse(AT);
    expect(() => buildEmfDocument("dup", 1, "Count", at, "ns", { dup: "x" })).toThrow(/collide/);
    expect(() => buildEmfDocument("m", 1, "Count", at, "ns", { _aws: "x" })).toThrow(/collide/);
  });
});

describe("EmfMetricSink", () => {
  it("writes exactly one JSON line per metric, counts default to 1", () => {
    const lines: string[] = [];
    const sink = new EmfMetricSink({ write: (l) => lines.push(l), clock: fixedClock(AT) });

    sink.count("reconciler.sweep.count");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"reconciler.sweep.count":1');
    expect(lines[0]).toContain('"Unit":"Count"');
  });
});
