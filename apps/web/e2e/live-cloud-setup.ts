// SPDX-License-Identifier: AGPL-3.0-or-later
// Provisioning for the LIVE portal Playwright run (playwright.live.config.ts):
// fresh DynamoDB table + catalog seed, and the container-mode sim's cloud state
// (VPC with egress, ECS cluster, log group). Runs via tsx from
// `start-live-app.sh` BEFORE `next start` — Playwright launches the webServer
// before globalSetup, so the server command owns provisioning. The resulting
// dynamic env (subnet/SG ids, host alias) is written to temp/live-pw.env,
// which the start script sources. Endpoint-only (§6.8).
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { awsSimClientConfig, createVpcWithEgress } from "@edd/e2e/aws-sim";
import { simulatorWorkloadHost } from "@edd/e2e/docker-host";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeBaseImageEntity } from "@edd/db";
import { aws, dynamodb } from "@edd/config";

const PORT = 3220; // must match playwright.live.config.ts
const RUN_ID = randomUUID().slice(0, 8);
const TABLE = "ecs-dev-desktop-pw-live";
const CLUSTER = `edd-pw-live-${RUN_ID}`;
const LOG_GROUP = `/edd/e2e/pw-live-${RUN_ID}`;
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const AGENT_SECRET = "d".repeat(64);
// 32-byte hex master key for the editor connection token. With it set, the compute
// provider injects each task's CONNECTION_TOKEN and the in-app proxy derives the same
// value to hand the browser its `?tkn=` — so "Open editor" reaches the workbench.
const CONNECTION_SECRET = "c".repeat(64);
const ENV_FILE = join(import.meta.dirname, "../temp/live-pw.env");

const dynamoEndpoint = process.env.DYNAMODB_ENDPOINT ?? dynamodb.endpoint;
process.env.DYNAMODB_ENDPOINT = dynamoEndpoint;
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= awsSimClientConfig().region;
process.env.AWS_ACCESS_KEY_ID ??= awsSimClientConfig().credentials.accessKeyId;
process.env.AWS_SECRET_ACCESS_KEY ??= awsSimClientConfig().credentials.secretAccessKey;

/** Shell-safe single-quoted export line. */
function exportLine(key: string, value: string): string {
  return `export ${key}='${value.replaceAll("'", "'\\''")}'`;
}

const SIM = awsSimClientConfig();

const dynamo = createDynamoClient();
await dropTable(dynamo, TABLE);
await ensureTable(dynamo, TABLE);
await new CatalogService({
  baseImages: makeBaseImageEntity(dynamo, TABLE),
  clock: systemClock,
}).create({ name: "Golden e2e", image: baseImage(WORKSPACE_IMAGE) });

const vpc = await createVpcWithEgress(new EC2Client(SIM), {
  vpcCidr: "10.73.0.0/16",
  subnetCidr: "10.73.1.0/24",
  securityGroupName: `pw-live-sg-${RUN_ID}`,
});
await new ECSClient(SIM).send(new CreateClusterCommand({ clusterName: CLUSTER }));
await new CloudWatchLogsClient(SIM).send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }));

// Workspace tasks must reach this app for idle-agent heartbeats (entrypoint
// env validation requires the URL either way) — probe the working host alias.
const hostAlias = simulatorWorkloadHost;

const lines = [
  exportLine("EDD_DEV_AUTH", "1"),
  exportLine("AUTH_SECRET", "pw-live-secret"),
  exportLine("DYNAMODB_ENDPOINT", dynamoEndpoint),
  exportLine("DYNAMODB_TABLE", TABLE),
  exportLine("EDD_APP_NAME", "edd-playwright-live"),
  exportLine("EDD_GOLDEN", "omnibus"),
  exportLine("EDD_IMAGE_SOURCE_REPO", "e6qu/ecs-dev-desktop"),
  exportLine("EDD_IMAGE_SOURCE_BRANCH", "main"),
  exportLine("EDD_IMAGE_SOURCE_WEBHOOK_SECRET", "playwright-live-image-source-webhook-secret"),
  exportLine("COMPUTE_PROVIDER", "ecs"),
  exportLine("AWS_ENDPOINT_URL", aws.endpoint),
  exportLine("AWS_REGION", SIM.region),
  exportLine("AWS_ACCESS_KEY_ID", SIM.credentials.accessKeyId),
  exportLine("AWS_SECRET_ACCESS_KEY", SIM.credentials.secretAccessKey),
  exportLine("ECS_CLUSTER", CLUSTER),
  exportLine("ECS_SUBNETS", vpc.subnetId),
  exportLine("ECS_SECURITY_GROUPS", vpc.securityGroupId),
  exportLine("ECS_EBS_ROLE_ARN", EBS_ROLE),
  exportLine("ECS_ASSIGN_PUBLIC_IP", "1"),
  exportLine("ECS_LOG_GROUP_WORKSPACES", LOG_GROUP),
  exportLine("CONTROL_PLANE_URL", `http://${hostAlias}:${String(PORT)}`),
  exportLine("EDD_AGENT_SECRET", AGENT_SECRET),
  exportLine("EDD_CONNECTION_SECRET", CONNECTION_SECRET),
];
mkdirSync(dirname(ENV_FILE), { recursive: true });
writeFileSync(ENV_FILE, lines.join("\n") + "\n");
process.stdout.write(`live cloud state ready (subnet ${vpc.subnetId}, host ${hostAlias})\n`);
