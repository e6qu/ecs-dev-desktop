// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EDD_METRIC_NAMESPACE,
  NoopMetricSink,
  systemClock,
  type Clock,
  type MetricDimensions,
  type MetricSink,
} from "@edd/core";

/** CloudWatch metric units we emit. */
export type MetricUnit = "Milliseconds" | "Count" | "None";

/**
 * A CloudWatch Embedded Metric Format document. The `_aws` block is the metric
 * metadata; the metric value and each dimension are top-level members keyed by
 * name (hence the `unknown`-valued index signature).
 */
export interface EmfDocument {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly { readonly Name: string; readonly Unit: MetricUnit }[];
    }[];
  };
  readonly [key: string]: unknown;
}

/** Pure: build the EMF document for one metric (no I/O — directly unit-testable). */
export function buildEmfDocument(
  name: string,
  value: number,
  unit: MetricUnit,
  timestampMs: number,
  namespace: string,
  dimensions: MetricDimensions,
): EmfDocument {
  // A dimension named like the metric (or `_aws`) would silently overwrite the metric
  // value / metadata block in the merged document, shipping a malformed metric. That can
  // only be a programming error (dimension keys are fixed literals) — fail loud (§6.5).
  if (name in dimensions || "_aws" in dimensions) {
    throw new Error(`EMF dimension key collides with the metric name or '_aws': ${name}`);
  }
  return {
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          // EMF requires an array of dimension sets; one (possibly empty) set.
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...dimensions,
    [name]: value,
  };
}

export interface EmfMetricSinkDeps {
  /** Where each EMF document (one JSON line) is written. Defaults to stdout. */
  write?: (line: string) => void;
  /** Clock for the EMF `Timestamp` (injectable for deterministic tests). */
  clock?: Clock;
  /** CloudWatch namespace; defaults to `EDD_METRIC_NAMESPACE`. */
  namespace?: string;
}

/**
 * `MetricSink` that emits the CloudWatch **Embedded Metric Format** to stdout —
 * the awslogs/Firelens driver ships it and CloudWatch extracts metrics from the
 * log line. This needs no `PutMetricData` API calls (no throttling, no extra IAM
 * beyond the log group) — the right shape for Fargate tasks. Identical against the
 * sim or real cloud; only whether the log stream reaches CloudWatch differs.
 */
export class EmfMetricSink implements MetricSink {
  private readonly write: (line: string) => void;
  private readonly clock: Clock;
  private readonly namespace: string;

  constructor(deps: EmfMetricSinkDeps = {}) {
    this.write = deps.write ?? ((line) => void process.stdout.write(`${line}\n`));
    this.clock = deps.clock ?? systemClock;
    this.namespace = deps.namespace ?? EDD_METRIC_NAMESPACE;
  }

  count(name: string, value = 1, dimensions?: MetricDimensions): void {
    this.emit(name, value, "Count", dimensions);
  }
  gauge(name: string, value: number, dimensions?: MetricDimensions): void {
    this.emit(name, value, "None", dimensions);
  }
  timing(name: string, milliseconds: number, dimensions?: MetricDimensions): void {
    this.emit(name, milliseconds, "Milliseconds", dimensions);
  }

  private emit(name: string, value: number, unit: MetricUnit, dimensions?: MetricDimensions): void {
    const timestamp = Date.parse(this.clock.now());
    // Fail loud: an unparseable clock value would serialize `Timestamp: null` into the EMF
    // document, which CloudWatch silently drops — a metric that looks emitted but never lands.
    if (Number.isNaN(timestamp)) {
      throw new Error(
        `EmfMetricSink: clock returned an unparseable timestamp: ${this.clock.now()}`,
      );
    }
    const document = buildEmfDocument(
      name,
      value,
      unit,
      timestamp,
      this.namespace,
      dimensions ?? {},
    );
    this.write(JSON.stringify(document));
  }
}

/**
 * The metric sink for the ambient environment: EMF when logs go to CloudWatch
 * (`LOG_PROVIDER=cloudwatch`, the production wiring the Terraform module sets),
 * else a no-op so local/test runs emit nothing. Coordinate-driven (§6.9).
 */
export function metricSinkFromEnv(): MetricSink {
  return process.env.LOG_PROVIDER === "cloudwatch" ? new EmfMetricSink() : new NoopMetricSink();
}
