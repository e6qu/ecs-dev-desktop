// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { awsSimClientConfig, createVpcWithEgress } from "@edd/e2e/aws-sim";

import globalSetup from "../e2e/global-setup";

await globalSetup();

const envFile = process.env.EDD_SHAUTH_ENV_FILE;
if (envFile === undefined || envFile.length === 0) {
  throw new Error("EDD_SHAUTH_ENV_FILE is required");
}

const runID = randomUUID().slice(0, 8);
const cluster = `edd-shauth-sso-${runID}`;
const logGroup = `/edd/e2e/shauth-sso-${runID}`;
const sim = awsSimClientConfig();
const vpc = await createVpcWithEgress(new EC2Client(sim), {
  vpcCidr: "10.74.0.0/16",
  subnetCidr: "10.74.1.0/24",
  securityGroupName: `shauth-sso-sg-${runID}`,
});
await new ECSClient(sim).send(new CreateClusterCommand({ clusterName: cluster }));
await new CloudWatchLogsClient(sim).send(new CreateLogGroupCommand({ logGroupName: logGroup }));

function exportLine(key: string, value: string): string {
  return `export ${key}='${value.replaceAll("'", "'\\''")}'`;
}

writeFileSync(
  envFile,
  [
    exportLine("COMPUTE_PROVIDER", "ecs"),
    exportLine("ECS_CLUSTER", cluster),
    exportLine("ECS_SUBNETS", vpc.subnetId),
    exportLine("ECS_SECURITY_GROUPS", vpc.securityGroupId),
    exportLine("ECS_EBS_ROLE_ARN", "arn:aws:iam::123456789012:role/ecsInfrastructureRole"),
    exportLine("ECS_ASSIGN_PUBLIC_IP", "1"),
    exportLine("ECS_LOG_GROUP_WORKSPACES", logGroup),
    exportLine("CONTROL_PLANE_URL", "http://host.docker.internal:3211"),
    exportLine("EDD_AGENT_SECRET", "a".repeat(64)),
    exportLine("EDD_CONNECTION_SECRET", "c".repeat(64)),
  ].join("\n") + "\n",
);
