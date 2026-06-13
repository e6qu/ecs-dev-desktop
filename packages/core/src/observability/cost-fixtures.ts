// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared cost-model test fixtures (pure values + event builders), imported by the
// core and control-plane cost tests so the rate table and the timeline helpers
// live in one place. Not part of the public API (not re-exported from index).
import { isoTimestamp } from "../domain/ids";

import type { AuditEvent } from "./audit";
import type { Pricing, WorkspaceSizing } from "./cost";

/** us-east-1 on-demand-style rates (mirrors the `@edd/config` defaults). */
export const TEST_PRICING: Pricing = {
  fargateVcpuHourUsd: 0.04048,
  fargateGbHourUsd: 0.004445,
  ebsGbMonthUsd: 0.08,
  snapshotGbMonthUsd: 0.05,
};

/** 512 CPU units (0.5 vCPU), 1 GiB memory, 8 GiB volume — the platform defaults. */
export const TEST_SIZING: WorkspaceSizing = { vcpu: 0.5, memoryGib: 1, volumeGib: 8 };

export const HOUR_MS = 60 * 60 * 1000;
export const T0_MS = Date.parse("2026-06-01T00:00:00.000Z");

/** An ISO timestamp `hours` after the fixture epoch `T0_MS`. */
export const atHours = (hours: number) =>
  isoTimestamp(new Date(T0_MS + hours * HOUR_MS).toISOString());

/** A lifecycle audit event `hours` after T0 (defaults: ws-1, owner alice). */
export const costEvent = (
  action: string,
  hours: number,
  target = "ws-1",
  actor = "alice@example.com",
): AuditEvent => ({ action, at: atHours(hours), actor, target, detail: "" });
