// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createLogger,
  InMemoryMetricSink,
  METRIC_IAM_PREFLIGHT_DENIED,
  systemClock,
  type StructuredLogger,
} from "@edd/core";
import type { IamPreflightResult } from "@edd/iam-preflight";
import { describe, expect, it } from "vitest";

import { reportIamPreflight } from "./iam-preflight-report";

interface CapturedLine {
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

function harness(): {
  logger: StructuredLogger;
  metrics: InMemoryMetricSink;
  lines: CapturedLine[];
} {
  const lines: CapturedLine[] = [];
  const logger = createLogger({
    service: "reconciler",
    clock: systemClock,
    write: (line) => {
      lines.push(JSON.parse(line) as CapturedLine);
    },
  });
  return { logger, metrics: new InMemoryMetricSink(), lines };
}

describe("reportIamPreflight", () => {
  it("emits a 0 denied metric + an info line when the check ran and all actions are allowed", () => {
    const { logger, metrics, lines } = harness();
    const result: IamPreflightResult = {
      signal: {
        kind: "checked",
        decisions: [
          { action: "ecs:StopTask", allowed: true },
          { action: "ec2:CreateSnapshot", allowed: true },
        ],
      },
      identity: {
        account: "123456789012",
        callerArn: "arn:aws:sts::123456789012:assumed-role/edd-reconciler/sess",
        principalArn: "arn:aws:iam::123456789012:role/edd-reconciler",
      },
    };

    reportIamPreflight(result, { logger, metrics });

    expect(metrics.recorded).toEqual([
      {
        kind: "count",
        name: METRIC_IAM_PREFLIGHT_DENIED,
        value: 0,
        dimensions: { component: "reconciler" },
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.checked).toBe(true);
    expect(lines[0]?.principalArn).toBe("arn:aws:iam::123456789012:role/edd-reconciler");
  });

  it("emits the denied count + an error line naming the denied actions", () => {
    const { logger, metrics, lines } = harness();
    const result: IamPreflightResult = {
      signal: {
        kind: "checked",
        decisions: [
          { action: "ecs:StopTask", allowed: false },
          { action: "ec2:CreateSnapshot", allowed: true },
          { action: "ec2:DeleteVolume", allowed: false },
        ],
      },
      identity: null,
    };

    reportIamPreflight(result, { logger, metrics });

    expect(metrics.recorded).toEqual([
      {
        kind: "count",
        name: METRIC_IAM_PREFLIGHT_DENIED,
        value: 2,
        dimensions: { component: "reconciler" },
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.deniedActions).toBe("ecs:StopTask, ec2:DeleteVolume");
    expect(lines[0]?.deniedCount).toBe(2);
  });

  it("does NOT emit a metric when unavailable, but logs an info line with the reason", () => {
    const { logger, metrics, lines } = harness();
    const result: IamPreflightResult = {
      signal: { kind: "unavailable", reason: "dev/fakes (COMPUTE_PROVIDER!=ecs)" },
      identity: null,
    };

    reportIamPreflight(result, { logger, metrics });

    expect(metrics.recorded).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.checked).toBe(false);
    expect(lines[0]?.reason).toBe("dev/fakes (COMPUTE_PROVIDER!=ecs)");
  });
});
