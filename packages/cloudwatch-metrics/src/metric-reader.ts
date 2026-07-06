// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { isoTimestamp, type IsoTimestamp } from "@edd/core";

/** One datapoint of a metric series. */
export interface MetricPoint {
  readonly at: IsoTimestamp;
  readonly value: number;
}

/** A single-series CloudWatch read (one namespace/metric/dimension set). */
export interface MetricSeriesQuery {
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly stat: "Average" | "Sum" | "Maximum";
  /** Datapoint period, seconds (CloudWatch requires multiples of 60 for recent data). */
  readonly periodS: number;
}

/** The result of reading one series. `available` is explicit (not a silent empty)
 * so the UI can distinguish "no datapoints yet" (available, empty points — e.g. a
 * brand-new workspace) from "this environment has no metrics source" (a note says
 * why — §6.5, no silent fallback). */
export interface MetricSeriesResult {
  readonly available: boolean;
  readonly note: string;
  readonly points: readonly MetricPoint[];
}

const SDK_MAX_ATTEMPTS = 3;

/**
 * Read-side companion to the EMF sink: pulls metric series from CloudWatch via
 * `GetMetricData` (Container Insights task utilization, per-volume EBS IOPS, the
 * app's own EMF metrics). Endpoint-only configuration (§6.8) — the same code hits
 * the sim or real cloud by `AWS_ENDPOINT_URL`/region env alone.
 */
export class CloudWatchMetricReader {
  constructor(private readonly client: CloudWatchClient) {}

  static fromEnv(): CloudWatchMetricReader {
    return new CloudWatchMetricReader(new CloudWatchClient({ maxAttempts: SDK_MAX_ATTEMPTS }));
  }

  async readSeries(
    query: MetricSeriesQuery,
    window: { readonly startMs: number; readonly endMs: number },
  ): Promise<MetricSeriesResult> {
    const dataQuery: MetricDataQuery = {
      Id: "m0",
      MetricStat: {
        Metric: {
          Namespace: query.namespace,
          MetricName: query.metricName,
          Dimensions: Object.entries(query.dimensions).map(([Name, Value]) => ({ Name, Value })),
        },
        Period: query.periodS,
        Stat: query.stat,
      },
    };
    try {
      const out = await this.client.send(
        new GetMetricDataCommand({
          StartTime: new Date(window.startMs),
          EndTime: new Date(window.endMs),
          MetricDataQueries: [dataQuery],
          ScanBy: "TimestampAscending",
        }),
      );
      const result = out.MetricDataResults?.[0];
      const stamps = result?.Timestamps ?? [];
      const values = result?.Values ?? [];
      const points: MetricPoint[] = stamps.flatMap((t, i) => {
        const v = values[i];
        return v === undefined ? [] : [{ at: isoTimestamp(t.toISOString()), value: v }];
      });
      return {
        available: true,
        note:
          points.length === 0
            ? `no ${query.namespace}/${query.metricName} datapoints in the window yet`
            : `${query.namespace}/${query.metricName} (${query.stat})`,
        points,
      };
    } catch (err) {
      // Fail explicit, not silent-empty: the caller renders the reason.
      return {
        available: false,
        note: `CloudWatch read failed: ${err instanceof Error ? err.message : String(err)}`,
        points: [],
      };
    }
  }
}
