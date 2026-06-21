// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  ListMetricsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { EDD_METRIC_NAMESPACE, METRIC_QUOTA_UTILIZATION } from "@edd/core";
import { beforeAll, describe, expect, it } from "vitest";

import { EmfMetricSink } from "../src/emf-metric-sink";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

// EMF reaches CloudWatch via the awslogs/Firelens driver shipping the stdout JSON line to
// a log group; CloudWatch then extracts the embedded metric (no PutMetricData). This integ
// proves the EXACT document `EmfMetricSink` produces is extractable + queryable through the
// CloudWatch metric APIs — i.e. our EMF shape is conformant, not just well-formed JSON.
const GROUP = "/edd-metrics-integ/control-plane";
const STREAM = "app/app/metrics-task";
// §6.10: derive the metric instant from the real clock so the live target accepts the
// PutLogEvents timestamp and the GetMetricStatistics window is always valid (never a stale
// hardcoded date). A single value emitted as a gauge → Maximum over the window is exact.
const NOW_MS = Date.now();
const UTILIZATION = 0.42;
const ROLE = "member";

describe("EmfMetricSink EMF → CloudWatch metric extraction (sockerless AWS sim)", () => {
  const cw = new CloudWatchClient({});
  const logs = new CloudWatchLogsClient({});

  /** The sim persists state across local runs, so creation is idempotent. */
  async function ensureExists(op: Promise<unknown>): Promise<void> {
    try {
      await op;
    } catch (e) {
      if (!(e instanceof ResourceAlreadyExistsException)) throw e;
    }
  }

  beforeAll(async () => {
    await ensureExists(logs.send(new CreateLogGroupCommand({ logGroupName: GROUP })));
    await ensureExists(
      logs.send(new CreateLogStreamCommand({ logGroupName: GROUP, logStreamName: STREAM })),
    );

    // Build the EMF line through the real sink (fixed clock = the metric instant), exactly
    // as a Fargate task's stdout would carry it, then ship it via PutLogEvents.
    const lines: string[] = [];
    const sink = new EmfMetricSink({
      write: (l) => lines.push(l),
      clock: { now: () => new Date(NOW_MS).toISOString() },
    });
    sink.gauge(METRIC_QUOTA_UTILIZATION, UTILIZATION, { role: ROLE });

    await logs.send(
      new PutLogEventsCommand({
        logGroupName: GROUP,
        logStreamName: STREAM,
        logEvents: lines.map((message) => ({ timestamp: NOW_MS, message })),
      }),
    );
  });

  it("lists the embedded metric under the edd namespace with its dimension", async () => {
    const out = await cw.send(new ListMetricsCommand({ Namespace: EDD_METRIC_NAMESPACE }));
    const metric = out.Metrics?.find((m) => m.MetricName === METRIC_QUOTA_UTILIZATION);
    expect(metric).toBeDefined();
    expect(metric?.Dimensions?.some((d) => d.Name === "role")).toBe(true);
  });

  it("returns the emitted gauge value via GetMetricStatistics for that dimension", async () => {
    const out = await cw.send(
      new GetMetricStatisticsCommand({
        Namespace: EDD_METRIC_NAMESPACE,
        MetricName: METRIC_QUOTA_UTILIZATION,
        Dimensions: [{ Name: "role", Value: ROLE }],
        // A window around the emit instant; the gauge is a single point, so Maximum is exact.
        StartTime: new Date(NOW_MS - 60_000),
        EndTime: new Date(NOW_MS + 60_000),
        Period: 60,
        Statistics: ["Maximum"],
      }),
    );
    const points = out.Datapoints ?? [];
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...points.map((p) => p.Maximum ?? Number.NaN))).toBeCloseTo(UTILIZATION, 5);
  });
});
