// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { describe, expect, it } from "vitest";

import { runEbsSmoke } from "./ebs-smoke";

// Point the SDK at the sockerless AWS simulator — the SAME `runEbsSmoke` the manual
// `e2e-aws` tier runs against real AWS (it differs only by these coordinates).
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

describe("runEbsSmoke against the sockerless AWS sim", () => {
  const ec2 = new EC2Client({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  it("runs the volume → snapshot → restore round-trip and tears its resources down", async () => {
    const result = await runEbsSmoke(ec2, `edd-ebs-smoke-integ-${randomUUID().slice(0, 8)}`);

    expect(result.snapshotId).toMatch(/^snap-/);
    expect(result.restoredVolumeId).toMatch(/^vol-/);
    expect(result.restoredVolumeId).not.toBe(result.sourceVolumeId);
    expect(result.snapshotLatencyMs).toBeGreaterThanOrEqual(0);

    // The `finally` teardown ran: the restored volume is gone (real EC2 + the sim
    // both raise InvalidVolume.NotFound for a deleted volume).
    await expect(
      ec2.send(new DescribeVolumesCommand({ VolumeIds: [result.restoredVolumeId] })),
    ).rejects.toMatchObject({ name: "InvalidVolume.NotFound" });
  }, 60_000);
});
