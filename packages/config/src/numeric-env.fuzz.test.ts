// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FARGATE_VCPU_HOUR_USD, workspacePricing, workspaceSizing } from "./index";

// The numeric env parsers must FAIL LOUD on garbage (NaN/Infinity/negative/empty
// where required) and ROUND-TRIP valid input. They read process.env directly (the
// values are externally-supplied coordinates), so the property drives them through
// env — restoring it after every run so a case can't leak into the next.

const PRICE_VARS = [
  "EDD_PRICE_FARGATE_VCPU_HOUR",
  "EDD_PRICE_FARGATE_GB_HOUR",
  "EDD_PRICE_EBS_GB_MONTH",
  "EDD_PRICE_SNAPSHOT_GB_MONTH",
];
const SIZING_VARS = ["ECS_TASK_CPU", "ECS_TASK_MEMORY", "ECS_VOLUME_GIB"];
const VARS = [...PRICE_VARS, ...SIZING_VARS];

let snapshot: Record<string, string | undefined>;
beforeEach(() => {
  snapshot = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
});
afterEach(() => {
  for (const v of VARS) {
    const value = snapshot[v];
    if (value === undefined) Reflect.deleteProperty(process.env, v);
    else process.env[v] = value;
  }
});

function setOrDelete(name: string, raw: string | undefined): void {
  if (raw === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = raw;
}

describe("priceEnv via workspacePricing (property)", () => {
  it("a finite non-negative rate round-trips", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }), (rate) => {
        process.env.EDD_PRICE_FARGATE_VCPU_HOUR = String(rate);
        expect(workspacePricing().fargateVcpuHourUsd).toBeCloseTo(rate, 9);
      }),
    );
  });

  it("an unset/empty override uses the configured default (never throws)", () => {
    fc.assert(
      fc.property(fc.constantFrom(undefined, ""), (raw) => {
        setOrDelete("EDD_PRICE_FARGATE_VCPU_HOUR", raw);
        expect(workspacePricing().fargateVcpuHourUsd).toBe(DEFAULT_FARGATE_VCPU_HOUR_USD);
      }),
    );
  });

  it("a negative or non-numeric rate fails loud (throws)", () => {
    // Only inputs that are genuinely negative or non-finite/non-numeric. (A bare
    // "0x10" or " " coerces to a finite non-negative number, so those are VALID.)
    const bad = fc.oneof(
      fc.double({ min: -1e6, max: -1e-9, noNaN: true, noDefaultInfinity: true }).map(String),
      fc.constantFrom("NaN", "Infinity", "-Infinity", "abc", "1.2.3", "-5"),
    );
    fc.assert(
      fc.property(bad, (raw) => {
        process.env.EDD_PRICE_FARGATE_VCPU_HOUR = raw;
        expect(() => workspacePricing()).toThrow();
      }),
    );
  });
});

describe("workspaceSizing (property)", () => {
  it("positive finite sizing round-trips", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16384 }),
        fc.integer({ min: 1, max: 131072 }),
        fc.integer({ min: 1, max: 16384 }),
        (cpuUnits, memoryMib, volumeGib) => {
          process.env.ECS_TASK_CPU = String(cpuUnits);
          process.env.ECS_TASK_MEMORY = String(memoryMib);
          process.env.ECS_VOLUME_GIB = String(volumeGib);
          const sizing = workspaceSizing();
          expect(sizing.vcpu).toBeCloseTo(cpuUnits / 1024, 9);
          expect(sizing.memoryGib).toBeCloseTo(memoryMib / 1024, 9);
          expect(sizing.volumeGib).toBe(volumeGib);
        },
      ),
    );
  });

  it("a non-positive or non-numeric sizing component fails loud (throws)", () => {
    const bad = fc.oneof(
      fc.integer({ min: -10000, max: 0 }).map(String),
      fc.constantFrom("NaN", "Infinity", "abc", "", " "),
    );
    fc.assert(
      fc.property(bad, fc.constantFrom(...SIZING_VARS), (raw, which) => {
        process.env.ECS_TASK_CPU = "512";
        process.env.ECS_TASK_MEMORY = "1024";
        process.env.ECS_VOLUME_GIB = "8";
        process.env[which] = raw;
        expect(() => workspaceSizing()).toThrow();
      }),
    );
  });
});
