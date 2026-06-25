// SPDX-License-Identifier: AGPL-3.0-or-later
import { InMemoryMetricSink, METRIC_QUOTA_DENIED, METRIC_QUOTA_UTILIZATION } from "@edd/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { recordQuotaUsage } from "./quota-metrics";

describe("recordQuotaUsage (fuzz)", () => {
  it("utilization gauge is always finite and >= 0; a denial is emitted iff !allowed", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.option(fc.integer(), { nil: null }),
        fc.string(),
        fc.boolean(),
        (owned, limit, role, allowed) => {
          const m = new InMemoryMetricSink();
          recordQuotaUsage(m, { owned, limit, role, allowed });

          const gauge = m.recorded.find((r) => r.name === METRIC_QUOTA_UTILIZATION);
          if (gauge === undefined) throw new Error("no utilization gauge emitted");
          expect(Number.isFinite(gauge.value)).toBe(true);
          expect(gauge.value).toBeGreaterThanOrEqual(0);

          const denied = m.recorded.some((r) => r.name === METRIC_QUOTA_DENIED);
          expect(denied).toBe(!allowed);
        },
      ),
    );
  });
});
