// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Pricing, WorkspaceSizing } from "@edd/core";

// Representative us-east-1 list prices + the default 0.5 vCPU / 1 GiB / 8 GiB sizing (matches
// the repo's `workspaceSizing()` default). The demo's cost figures are the REAL cost model run
// over the seeded audit ledger with these inputs — only the prices/sizing are constants here.
export const DEMO_PRICING: Pricing = {
  fargateVcpuHourUsd: 0.04048,
  fargateGbHourUsd: 0.004445,
  ebsGbMonthUsd: 0.08,
  snapshotGbMonthUsd: 0.05,
};

export const DEMO_SIZING: WorkspaceSizing = {
  vcpu: 0.5,
  memoryGib: 1,
  volumeGib: 8,
};
