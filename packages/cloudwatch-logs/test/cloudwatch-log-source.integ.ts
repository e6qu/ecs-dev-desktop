// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";

import { CloudWatchLogSource } from "../src/cloudwatch-log-source";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const APP_NAME = "edd-cw-integ";
const GROUP = `/${APP_NAME}/control-plane`;
const STREAM = "app/app/test-task";

describe("CloudWatchLogSource against the sockerless AWS sim", () => {
  const cw = new CloudWatchLogsClient({});
  const src = CloudWatchLogSource.fromEnv(APP_NAME);

  beforeAll(async () => {
    await cw.send(new CreateLogGroupCommand({ logGroupName: GROUP }));
    await cw.send(new CreateLogStreamCommand({ logGroupName: GROUP, logStreamName: STREAM }));
    await cw.send(
      new PutLogEventsCommand({
        logGroupName: GROUP,
        logStreamName: STREAM,
        logEvents: [
          { timestamp: Date.now(), message: "info: workspace ws-abc created" },
          { timestamp: Date.now(), message: "warn: heartbeat timeout ws-xyz" },
          { timestamp: Date.now(), message: "error: failed to stop task" },
        ],
      }),
    );
  });

  it("reads seeded lines from the control-plane stream", async () => {
    const result = await src.read("control-plane");
    expect(result.stream).toBe("control-plane");
    expect(result.available).toBe(true);
    expect(result.lines.length).toBeGreaterThanOrEqual(3);
  });

  it("maps log levels from message content", async () => {
    const result = await src.read("control-plane");
    const levels = result.lines.map((l) => l.level);
    expect(levels).toContain("info");
    expect(levels).toContain("warn");
    expect(levels).toContain("error");
  });

  // Gated: e6qu/sockerless#483 — FilterLogEvents returns empty results instead of
  // ResourceNotFoundException for a non-existent log group. Un-gate once fixed upstream.
  it.skip("returns available:false for a stream whose log group does not exist", async () => {
    const result = await CloudWatchLogSource.fromEnv("no-such-app").read("reconciler");
    expect(result.available).toBe(false);
    expect(result.lines).toHaveLength(0);
  });

  it("every line has the required LogLine shape", async () => {
    const result = await src.read("control-plane");
    for (const line of result.lines) {
      expect(typeof line.at).toBe("string");
      expect(["info", "warn", "error"]).toContain(line.level);
      expect(typeof line.source).toBe("string");
      expect(typeof line.message).toBe("string");
    }
  });
});
