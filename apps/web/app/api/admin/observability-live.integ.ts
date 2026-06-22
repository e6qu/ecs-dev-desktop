// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
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

/** Poll CloudTrail for events of a given name, SCOPED server-side by EventName so the
 * query is robust to the shared sim CloudTrail (every integ test logs into it; the
 * admin feed is a capped newest-first view, so a specific event can be legitimately
 * crowded out). `match` further narrows to this run's resource when the sim records one
 * (CloudTrail is eventually consistent, so poll briefly). */
async function recordedEvent(
  ct: CloudTrailClient,
  eventName: string,
  match: (resourceName: string | undefined) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const out = await ct.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: eventName }],
        MaxResults: 50,
      }),
    );
    if ((out.Events ?? []).some((e) => match(e.Resources?.[0]?.ResourceName))) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

let SEEDED_VOLUME = "";

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
    SEEDED_VOLUME = volume.id;
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

  it("serves a well-formed CloudTrail-backed audit feed through the admin API route", async () => {
    // The route works: it returns a non-empty, contract-shaped feed of CloudTrail-derived
    // audit events. We don't assert a SPECIFIC event here — the feed is a capped,
    // newest-first view of a CloudTrail shared by every integ test, so a particular event
    // can be legitimately crowded out. The platform's own ops are verified (scoped) below.
    const res = await auditGet(adminRequest(`${ADMIN}/audit`));
    expect(res.status).toBe(200);
    const body = auditFeedResponse.parse(await json(res));
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("records the platform's real ECS/EBS operations in CloudTrail (scoped to this run)", async () => {
    // The actual EC2/ECS calls the platform makes must reach CloudTrail. Verified via a
    // server-side EventName-scoped LookupEvents (robust to the shared, capped feed),
    // narrowed to this run's resource where the sim records one. If the sim did not
    // record these standard ops, that would be a coordinate-level divergence to file
    // upstream (e6qu/sockerless), not to work around.
    const ct = new CloudTrailClient(SIM);
    expect(await recordedEvent(ct, "CreateCluster", (r) => r === SEEDED_CLUSTER)).toBe(true);
    // The sim records CreateSnapshot against its source volume id.
    expect(await recordedEvent(ct, "CreateSnapshot", (r) => r === SEEDED_VOLUME)).toBe(true);
    // CreateVolume carries no ResourceName from the sim; assert the op is recorded at all.
    expect(await recordedEvent(ct, "CreateVolume", () => true)).toBe(true);
  });

  it("serves CloudWatch-backed control-plane logs through the admin API route", async () => {
    const res = await logsGet(adminRequest(`${ADMIN}/logs?stream=control-plane`));
    expect(res.status).toBe(200);

    const body = logStreamResult.parse(await json(res));
    expect(body.available).toBe(true);
    expect(body.lines.some((line) => line.message === SEEDED_LOG)).toBe(true);
  });
});
