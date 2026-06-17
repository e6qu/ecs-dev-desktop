// SPDX-License-Identifier: AGPL-3.0-or-later
import { metricSinkFromEnv } from "@edd/cloudwatch-metrics";
import type { MetricSink } from "@edd/core";

let sink: MetricSink | undefined;

/** The shared application metric sink (CloudWatch EMF when `LOG_PROVIDER=cloudwatch`,
 * a no-op sink otherwise). Memoized so routes don't rebuild it per request. */
export function getMetrics(): MetricSink {
  sink ??= metricSinkFromEnv();
  return sink;
}
