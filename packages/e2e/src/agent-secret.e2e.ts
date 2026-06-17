// SPDX-License-Identifier: AGPL-3.0-or-later
// The agent-token-via-Secrets-Manager security fix, proven against the
// CONTAINER-MODE AWS sim (where managed-EBS RunTask runs for real). The provider
// stashes the per-workspace HMAC token in Secrets Manager and references it from
// the task definition's container `secrets`, instead of injecting it as plaintext
// `environment` (where it would surface in DescribeTasks/CloudTrail). We launch a
// real task through the provider, then assert the secret holds the right value,
// the task def references it, and the token never appears as a plaintext env var.
//
// (Functional resolution — the in-workspace agent authenticating with the
// secret-injected token — is covered by the user-journey heartbeat e2e, whose
// provider also now takes the Secrets Manager path via fromEnv.) Endpoint-only.
import { randomUUID } from "node:crypto";

import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateSubnetCommand, CreateVpcCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  CreateClusterCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { agentToken, EcsComputeProvider } from "@edd/compute-ecs";
import { baseImage, workspaceId } from "@edd/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { awsSimClientConfig, configureAwsSimEnv, required } from "./aws-sim";

configureAwsSimEnv();

const SIM = awsSimClientConfig();
const RUN_ID = randomUUID().slice(0, 8);
const CLUSTER = `edd-agent-secret-${RUN_ID}`;
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const WORKSPACE_CONTAINER = "workspace";
const WS_ID = `ws-secret-${RUN_ID}`;
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const AGENT_SECRET = "a".repeat(64); // 32-byte hex master HMAC key (test value)
const CONTROL_PLANE_URL = "http://127.0.0.1:3000";
const LOG_GROUP = `/edd/e2e/agent-secret-${RUN_ID}`;

describe(
  "agent token delivered via Secrets Manager (container-mode sim)",
  { timeout: 180_000 },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);
    const sm = new SecretsManagerClient(SIM);
    const logs = new CloudWatchLogsClient(SIM);
    let taskArn: string | undefined;
    let taskDefArn: string;

    beforeAll(async () => {
      const vpc = await ec2.send(new CreateVpcCommand({ CidrBlock: "10.82.0.0/16" }));
      const subnet = await ec2.send(
        new CreateSubnetCommand({
          VpcId: required(vpc.Vpc?.VpcId, "VpcId"),
          CidrBlock: "10.82.1.0/24",
        }),
      );
      await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
      await logs.send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }));

      const compute = new EcsComputeProvider({
        client: ecs,
        secretsClient: sm,
        config: {
          cluster: CLUSTER,
          subnets: [required(subnet.Subnet?.SubnetId, "SubnetId")],
          ebsRoleArn: EBS_ROLE,
          assignPublicIp: false,
          containerName: WORKSPACE_CONTAINER,
          controlPlaneUrl: CONTROL_PLANE_URL,
          agentSecret: AGENT_SECRET,
          logGroupName: LOG_GROUP,
        },
      });
      const task = await compute.runTask({
        workspaceId: workspaceId(WS_ID),
        baseImage: baseImage(WORKSPACE_IMAGE),
      });
      taskArn = task.id;
      const tasks = await ecs.send(
        new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }),
      );
      taskDefArn = required(tasks.tasks?.[0]?.taskDefinitionArn, "taskDefinitionArn");
    });

    afterAll(async () => {
      if (taskArn !== undefined) {
        await ecs
          .send(new StopTaskCommand({ cluster: CLUSTER, task: taskArn }))
          .catch(() => undefined);
      }
    });

    it("stores the agent token in Secrets Manager with the correct HMAC value", async () => {
      const secret = await sm.send(
        new GetSecretValueCommand({ SecretId: `edd/workspace/${WS_ID}/agent` }),
      );
      expect(secret.SecretString).toBe(agentToken(AGENT_SECRET, WS_ID));
    });

    it("references the secret from the task def, never as plaintext env", async () => {
      const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));
      const container = td.taskDefinition?.containerDefinitions?.[0];
      expect((container?.secrets ?? []).map((s) => s.name)).toContain("EDD_AGENT_TOKEN");
      expect((container?.environment ?? []).map((e) => e.name)).not.toContain("EDD_AGENT_TOKEN");
    });
  },
);
