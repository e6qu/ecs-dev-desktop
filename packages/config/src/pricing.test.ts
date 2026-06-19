// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EBS_GB_MONTH_USD,
  DEFAULT_FARGATE_VCPU_HOUR_USD,
  workspacePricing,
  workspaceSizing,
} from "./index";

const VARS = [
  "EDD_PRICE_FARGATE_VCPU_HOUR",
  "EDD_PRICE_FARGATE_GB_HOUR",
  "EDD_PRICE_EBS_GB_MONTH",
  "EDD_PRICE_SNAPSHOT_GB_MONTH",
  "ECS_TASK_CPU",
  "ECS_TASK_MEMORY",
  "ECS_VOLUME_GIB",
];

// Snapshot the pricing/sizing env before each test and restore after, so a test
// that sets an override never leaks into the next (and the defaults still apply).
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

describe("workspacePricing", () => {
  it("uses the us-east-1 on-demand defaults when unset", () => {
    // Pin the actual rates (not just `=== DEFAULT_*`, which is tautological) so a
    // typo'd default rate fails loudly. Keep in sync with the documented us-east-1
    // on-demand prices in `@edd/config`; the constants are asserted so a drift there
    // also trips this.
    expect(DEFAULT_FARGATE_VCPU_HOUR_USD).toBe(0.04048);
    expect(DEFAULT_EBS_GB_MONTH_USD).toBe(0.08);
    expect(workspacePricing().fargateVcpuHourUsd).toBe(0.04048);
    expect(workspacePricing().ebsGbMonthUsd).toBe(0.08);
  });

  it("honours an EDD_PRICE_* override", () => {
    process.env.EDD_PRICE_FARGATE_VCPU_HOUR = "0.05";
    expect(workspacePricing().fargateVcpuHourUsd).toBe(0.05);
  });

  it("rejects a negative rate (fails loudly, never silently misprices)", () => {
    process.env.EDD_PRICE_EBS_GB_MONTH = "-1";
    expect(() => workspacePricing()).toThrow();
  });
});

describe("workspaceSizing", () => {
  it("converts the default ECS task size to vCPU / GiB", () => {
    expect(workspaceSizing()).toEqual({ vcpu: 0.5, memoryGib: 1, volumeGib: 8 });
  });

  it("tracks the ECS_* provisioning overrides", () => {
    process.env.ECS_TASK_CPU = "1024";
    process.env.ECS_TASK_MEMORY = "2048";
    process.env.ECS_VOLUME_GIB = "20";
    expect(workspaceSizing()).toEqual({ vcpu: 1, memoryGib: 2, volumeGib: 20 });
  });

  it("rejects a non-positive size", () => {
    process.env.ECS_VOLUME_GIB = "0";
    expect(() => workspaceSizing()).toThrow();
  });
});
