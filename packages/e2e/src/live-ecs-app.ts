// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared harness for e2e that drive the REAL control plane on REAL sim compute:
// provision the container-mode cloud state (VPC with egress, ECS cluster, log
// group), seed a catalog entry, and start the production-built web app wired to
// EcsComputeProvider/Ec2StorageProvider (COMPUTE_PROVIDER=ecs). Endpoint-only
// (§6.8) — only AWS endpoint/credentials differ from real cloud.
import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateClusterCommand,
  ECSClient,
  ListTasksCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { awsSim, dynamodbLocal } from "@edd/config";
import { CatalogService } from "@edd/control-plane";
import { baseImage, systemClock } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeBaseImageEntity } from "@edd/db";

import { awsSimClientConfig, createVpcWithEgress } from "./aws-sim";
import { hostReachableTarget } from "./docker-host";
import { startWebApp, type WebApp } from "./web-app";

const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";

export interface LiveEcsApp {
  web: WebApp;
  ec2: EC2Client;
  ecs: ECSClient;
  cluster: string;
  subnetId: string;
  securityGroupId: string;
  /** Tear down the web app and drop the DynamoDB table. */
  stop: () => Promise<void>;
}

export interface LiveEcsAppOptions {
  /** Unique per-run suffix so cloud resources never collide across suites. */
  runId: string;
  /** Workspace image the catalog offers (the golden image for real tasks). */
  workspaceImage: string;
  /** /16 and /24 CIDRs for this run's VPC (distinct per suite). */
  vpcCidr: string;
  subnetCidr: string;
  /** 32-byte hex agent secret for the in-workspace idle-agent HMAC path. */
  agentSecret: string;
  /** Trusted SSH CA public key injected into workspace tasks. */
  sshCaPublicKey: string;
  /** Extra env merged into the web app (e.g. EDD_HEARTBEAT_INTERVAL_S). */
  extraEnv?: Record<string, string>;
}

/**
 * Provision the cloud state and start the web app on real sim compute. The
 * control-plane URL uses the probed host alias so in-workspace idle-agents can
 * reach it from inside sim task containers.
 */
export async function startLiveEcsApp(opts: LiveEcsAppOptions): Promise<LiveEcsApp> {
  const sim = awsSimClientConfig();
  const table = `edd-live-${opts.runId}`;
  const cluster = `edd-live-${opts.runId}`;
  const logGroup = `/edd/e2e/live-${opts.runId}`;
  const dynamoEndpoint = process.env.DYNAMODB_ENDPOINT ?? dynamodbLocal.endpoint;

  const dynamo = createDynamoClient();
  await dropTable(dynamo, table);
  await ensureTable(dynamo, table);
  await new CatalogService({
    baseImages: makeBaseImageEntity(dynamo, table),
    clock: systemClock,
  }).create({ name: "Golden e2e", image: baseImage(opts.workspaceImage) });

  const ec2 = new EC2Client(sim);
  const ecs = new ECSClient(sim);
  const vpc = await createVpcWithEgress(ec2, {
    vpcCidr: opts.vpcCidr,
    subnetCidr: opts.subnetCidr,
    securityGroupName: `live-sg-${opts.runId}`,
  });
  await ecs.send(new CreateClusterCommand({ clusterName: cluster }));
  await new CloudWatchLogsClient(sim).send(new CreateLogGroupCommand({ logGroupName: logGroup }));

  const hostAlias = hostReachableTarget(opts.workspaceImage).host;
  const web = await startWebApp((port) => ({
    DYNAMODB_ENDPOINT: dynamoEndpoint,
    DYNAMODB_TABLE: table,
    COMPUTE_PROVIDER: "ecs",
    AWS_ENDPOINT_URL: awsSim.endpoint,
    AWS_REGION: sim.region,
    AWS_ACCESS_KEY_ID: sim.credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: sim.credentials.secretAccessKey,
    ECS_CLUSTER: cluster,
    ECS_SUBNETS: vpc.subnetId,
    ECS_SECURITY_GROUPS: vpc.securityGroupId,
    ECS_EBS_ROLE_ARN: EBS_ROLE,
    ECS_ASSIGN_PUBLIC_IP: "1",
    ECS_LOG_GROUP_WORKSPACES: logGroup,
    CONTROL_PLANE_URL: `http://${hostAlias}:${String(port)}`,
    EDD_AGENT_SECRET: opts.agentSecret,
    EDD_SSH_CA_PUBLIC_KEY: opts.sshCaPublicKey,
    ...opts.extraEnv,
  }));

  return {
    web,
    ec2,
    ecs,
    cluster,
    subnetId: vpc.subnetId,
    securityGroupId: vpc.securityGroupId,
    stop: async () => {
      web.stop();
      // Drain the cluster's still-running tasks so this suite doesn't leak
      // golden-image containers into the shared sim for later suites (cumulative
      // load was a source of "task stopped before RUNNING" flakes downstream).
      try {
        const listed = await ecs.send(new ListTasksCommand({ cluster, desiredStatus: "RUNNING" }));
        await Promise.all(
          (listed.taskArns ?? []).map((task) => ecs.send(new StopTaskCommand({ cluster, task }))),
        );
      } catch {
        // Best-effort cleanup — never fail teardown over it.
      }
      await dropTable(createDynamoClient(), table);
    },
  };
}
