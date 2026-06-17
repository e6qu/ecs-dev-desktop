// SPDX-License-Identifier: AGPL-3.0-or-later
import { METRIC_QUOTA_DENIED, METRIC_QUOTA_UTILIZATION, type MetricSink } from "@edd/core";

/**
 * Emit per-role workspace-quota signals on a create attempt: a **utilization**
 * gauge (`owned / limit`, dimensioned by role; `0` when the role is unlimited) and,
 * when the create was denied because the quota was reached, a **denial** count.
 * Dimensioned by role only, to keep the metric cardinality bounded.
 */
export function recordQuotaUsage(
  metrics: MetricSink,
  args: { owned: number; limit: number | null; role: string; allowed: boolean },
): void {
  const dimensions = { role: args.role };
  const utilization = args.limit !== null && args.limit > 0 ? args.owned / args.limit : 0;
  metrics.gauge(METRIC_QUOTA_UTILIZATION, utilization, dimensions);
  if (!args.allowed) metrics.count(METRIC_QUOTA_DENIED, 1, dimensions);
}
