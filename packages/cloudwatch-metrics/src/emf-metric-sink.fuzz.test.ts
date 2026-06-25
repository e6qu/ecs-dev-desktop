// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildEmfDocument } from "./emf-metric-sink";

describe("buildEmfDocument (fuzz)", () => {
  it("round-trips: the metric value + every dimension survive, JSON-serializable, no key loss", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer(),
        fc.string(),
        fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        (name, value, namespace, dimensions) => {
          fc.pre(!(name in dimensions) && !("_aws" in dimensions)); // the collision guard's domain
          const doc = buildEmfDocument(name, value, "Count", 0, namespace, dimensions);
          expect(doc[name]).toBe(value);
          for (const [k, v] of Object.entries(dimensions)) expect(doc[k]).toBe(v);
          expect(doc._aws.CloudWatchMetrics[0]?.Dimensions[0]).toEqual(Object.keys(dimensions));
          // The whole doc survives a JSON round-trip (no Timestamp:null / dropped keys).
          const round: unknown = JSON.parse(JSON.stringify(doc));
          expect((round as Record<string, unknown>)[name]).toBe(value);
        },
      ),
    );
  });

  it("throws when a dimension key collides with the metric name or '_aws'", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (name) => {
        expect(() => buildEmfDocument(name, 1, "Count", 0, "ns", { [name]: "x" })).toThrow(
          /collide/,
        );
        expect(() => buildEmfDocument(name, 1, "Count", 0, "ns", { _aws: "x" })).toThrow(/collide/);
      }),
    );
  });
});
