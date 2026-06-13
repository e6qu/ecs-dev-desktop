// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { auditFeedResponse, logStreamResult } from "@edd/api-contracts";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DEV_AUTH_ENABLED,
  DEV_AUTH_ENV,
  ROLE_HEADER,
  USER_ID_HEADER,
} from "../../../lib/constants";
import { GET as auditGet } from "./audit/route";
import { GET as logsGet } from "./logs/route";

process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env[DEV_AUTH_ENV] = DEV_AUTH_ENABLED;
process.env.AUDIT_PROVIDER = "cloudtrail";
process.env.LOG_PROVIDER = "cloudwatch";

const RUN_ID = randomUUID().slice(0, 8);
process.env.EDD_APP_NAME = `edd-web-observability-${RUN_ID}`;

const ADMIN = "http://localhost/api/admin";
const LOG_GROUP = `/${process.env.EDD_APP_NAME}/control-plane`;
const LOG_STREAM = "app/app/live-route-test";
const SEEDED_CLUSTER = `edd-web-admin-observability-${RUN_ID}`;
const SEEDED_LOG = "info: live admin route read from CloudWatch";

const SIM = {
  region: DEFAULT_AWS_REGION,
  endpoint: aws.endpoint,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

function adminRequest(url: string): Request {
  return new Request(url, {
    headers: { [USER_ID_HEADER]: "admin", [ROLE_HEADER]: "admin" },
  });
}

async function json(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}

describe("admin observability routes against live AWS simulator adapters", () => {
  beforeAll(async () => {
    const ecs = new ECSClient(SIM);
    const logs = new CloudWatchLogsClient(SIM);

    await ecs.send(new CreateClusterCommand({ clusterName: SEEDED_CLUSTER }));

    // Exercise OUR real EBS adapter (the product path, coordinate-only via
    // AWS_ENDPOINT_URL) so the CloudTrail feed must capture the actual EC2 calls
    // the platform makes — not just a bare CreateCluster.
    const storage = Ec2StorageProvider.fromEnv();
    const volume = await storage.createVolume();
    await storage.createSnapshot(volume.id);
    await logs.send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }));
    await logs.send(
      new CreateLogStreamCommand({ logGroupName: LOG_GROUP, logStreamName: LOG_STREAM }),
    );
    await logs.send(
      new PutLogEventsCommand({
        logGroupName: LOG_GROUP,
        logStreamName: LOG_STREAM,
        logEvents: [{ timestamp: Date.now(), message: SEEDED_LOG }],
      }),
    );
  });

  it("serves the CloudTrail-backed audit feed through the admin API route", async () => {
    const res = await auditGet(adminRequest(`${ADMIN}/audit`));
    expect(res.status).toBe(200);

    const body = auditFeedResponse.parse(await json(res));
    expect(body.events.some((event) => event.action === "CreateCluster")).toBe(true);
  });

  it("captures the platform's real EBS operations (CreateVolume + CreateSnapshot) in the feed", async () => {
    // Coverage for the actual EC2/EBS calls the EBS provider makes — previously
    // only a bare CreateCluster was asserted. If the CloudTrail adapter/sim does
    // not record these standard ops, that is a coordinate-level divergence to
    // file upstream (e6qu/sockerless), not to work around.
    const res = await auditGet(adminRequest(`${ADMIN}/audit`));
    expect(res.status).toBe(200);
    const actions = new Set(auditFeedResponse.parse(await json(res)).events.map((e) => e.action));
    expect(actions.has("CreateVolume")).toBe(true);
    expect(actions.has("CreateSnapshot")).toBe(true);
  });

  it("serves CloudWatch-backed control-plane logs through the admin API route", async () => {
    const res = await logsGet(adminRequest(`${ADMIN}/logs?stream=control-plane`));
    expect(res.status).toBe(200);

    const body = logStreamResult.parse(await json(res));
    expect(body.available).toBe(true);
    expect(body.lines.some((line) => line.message === SEEDED_LOG)).toBe(true);
  });
});
