// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateSubnetCommand,
  CreateVpcCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  CreateClusterCommand as CreateEcsClusterCommand,
  DescribeTasksCommand,
  ECSClient,
  ExecuteCommandCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { DEFAULT_AWS_REGION } from "@edd/config";
import { baseImage, workspaceId, workspacePrincipal } from "@edd/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { awsSimClientConfig, configureAwsSimEnv, required, sleep } from "./aws-sim";
import { run, taskExitCode } from "./golden-ssh-helpers";

configureAwsSimEnv();

const RUN_ID = randomUUID().slice(0, 8);
const CLUSTER = `edd-golden-ssh-${RUN_ID}`;
const VPC_CIDR = "10.71.0.0/16";
const SUBNET_CIDR = "10.71.1.0/24";
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const CLIENT_CONTAINER = "client";
const WORKSPACE_CONTAINER = "workspace";
const WORKSPACE_ID = `ws-golden-${RUN_ID}`;
const LOG_GROUP = `/edd/e2e/golden-ssh-${RUN_ID}`;
const CONTROL_PLANE_URL = "http://127.0.0.1:3000";
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const AGENT_SECRET = "a".repeat(64);
const SSH_ATTEMPTS = 30;
const SSH_CA_DIR = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca");
const CA_KEY = join(SSH_CA_DIR, "ca");
const CA_PUB = join(SSH_CA_DIR, "ca.pub");
const USER_KEY = join(SSH_CA_DIR, `golden-${RUN_ID}`);

const SIM = awsSimClientConfig();

async function waitForTask(
  ecs: ECSClient,
  taskArn: string,
  status: "RUNNING" | "STOPPED",
): Promise<Task> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }));
    const task = required(out.tasks?.[0], "task");
    if (task.lastStatus === status) return task;
    if (status === "RUNNING" && task.lastStatus === "STOPPED") {
      throw new Error(`task ${taskArn} stopped before RUNNING: ${task.stoppedReason ?? "unknown"}`);
    }
    await sleep(1_000);
  }
  throw new Error(`task ${taskArn} never reached ${status}`);
}

function signUserCert(principal: string): { privateKeyBase64: string; cert: string } {
  for (const path of [USER_KEY, `${USER_KEY}.pub`, `${USER_KEY}-cert.pub`]) {
    rmSync(path, { force: true });
  }
  const keygen = run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    USER_KEY,
    "-C",
    "edd-golden-workspace-e2e",
  ]);
  if (keygen.status !== 0) throw new Error(`ssh-keygen key failed: ${keygen.stderr}`);

  const signed = run("ssh-keygen", [
    "-s",
    CA_KEY,
    "-I",
    `edd-golden-${RUN_ID}`,
    "-n",
    principal,
    "-V",
    "+1h",
    `${USER_KEY}.pub`,
  ]);
  if (signed.status !== 0) throw new Error(`ssh-keygen sign failed: ${signed.stderr}`);

  return {
    privateKeyBase64: readFileSync(USER_KEY).toString("base64"),
    cert: readFileSync(`${USER_KEY}-cert.pub`, "utf8").trim(),
  };
}

describe(
  "golden workspace image against the container-mode AWS simulator",
  { timeout: 240_000 },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);
    const logs = new CloudWatchLogsClient(SIM);
    let subnetId: string;
    let vpcId: string;

    beforeAll(async () => {
      const vpcOut = await ec2.send(new CreateVpcCommand({ CidrBlock: VPC_CIDR }));
      vpcId = required(vpcOut.Vpc?.VpcId, "VpcId");
      const subnetOut = await ec2.send(
        new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: SUBNET_CIDR }),
      );
      subnetId = required(subnetOut.Subnet?.SubnetId, "SubnetId");
      await ecs.send(new CreateEcsClusterCommand({ clusterName: CLUSTER }));
      await logs.send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }));
    });

    afterAll(async () => {
      await ec2.send(new DeleteSubnetCommand({ SubnetId: subnetId }));
      await ec2.send(new DeleteVpcCommand({ VpcId: vpcId }));
    });

    async function runWorkspaceTask(): Promise<{ taskArn: string; sshHost: string }> {
      const compute = new EcsComputeProvider({
        client: ecs,
        config: {
          cluster: CLUSTER,
          subnets: [subnetId],
          ebsRoleArn: EBS_ROLE,
          assignPublicIp: false,
          containerName: WORKSPACE_CONTAINER,
          controlPlaneUrl: CONTROL_PLANE_URL,
          agentSecret: AGENT_SECRET,
          sshCaPublicKey: readFileSync(CA_PUB, "utf8").trim(),
          logGroupName: LOG_GROUP,
        },
      });
      const task = await compute.runTask({
        workspaceId: workspaceId(WORKSPACE_ID),
        baseImage: baseImage(WORKSPACE_IMAGE),
      });
      return { taskArn: task.id, sshHost: required(task.sshHost, "sshHost") };
    }

    async function registerClientTask(
      host: string,
      privateKeyBase64: string,
      cert: string,
    ): Promise<string> {
      const script = [
        'printf "%s" "$SSH_PRIVATE_KEY_B64" | base64 -d > /tmp/id',
        'printf "%s\\n" "$SSH_CERT" > /tmp/id-cert.pub',
        "chmod 600 /tmp/id /tmp/id-cert.pub",
        `for i in $(seq 1 ${SSH_ATTEMPTS}); do`,
        `  ssh -i /tmp/id -o CertificateFile=/tmp/id-cert.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 workspace@${host} whoami > /tmp/out 2>&1 && grep -q '^workspace$' /tmp/out && exit 0`,
        "  sleep 2",
        "done",
        "cat /tmp/out >&2",
        "exit 1",
      ].join("\n");
      const out = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family: `golden-ssh-client-${RUN_ID}`,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: "256",
          memory: "512",
          containerDefinitions: [
            {
              name: CLIENT_CONTAINER,
              image: WORKSPACE_IMAGE,
              essential: true,
              entryPoint: ["sh", "-c"],
              command: [script],
              environment: [
                { name: "SSH_PRIVATE_KEY_B64", value: privateKeyBase64 },
                { name: "SSH_CERT", value: cert },
              ],
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": LOG_GROUP,
                  "awslogs-region": DEFAULT_AWS_REGION,
                  "awslogs-stream-prefix": "golden-client",
                },
              },
            },
          ],
        }),
      );
      return required(out.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");
    }

    async function logMessages(): Promise<string> {
      const out = await logs.send(new FilterLogEventsCommand({ logGroupName: LOG_GROUP }));
      return (out.events ?? []).map((event) => event.message ?? "").join("\n");
    }

    it("launches the managed-EBS golden image and accepts CA-signed SSH", async () => {
      const { taskArn: workspaceTaskArn, sshHost } = await runWorkspaceTask();
      try {
        await waitForTask(ecs, workspaceTaskArn, "RUNNING");
        expect(sshHost).toMatch(/^10\.71\.1\.\d+$/);

        const { privateKeyBase64, cert } = signUserCert(workspacePrincipal(WORKSPACE_ID));
        const clientTaskDef = await registerClientTask(sshHost, privateKeyBase64, cert);
        const clientRun = await ecs.send(
          new RunTaskCommand({
            cluster: CLUSTER,
            taskDefinition: clientTaskDef,
            launchType: "FARGATE",
            networkConfiguration: {
              awsvpcConfiguration: { subnets: [subnetId], assignPublicIp: "DISABLED" },
            },
          }),
        );
        const clientTask = required(clientRun.tasks?.[0]?.taskArn, "client taskArn");
        const stopped = await waitForTask(ecs, clientTask, "STOPPED");
        expect(taskExitCode(stopped), await logMessages()).toBe(0);
      } finally {
        await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: workspaceTaskArn }));
        await waitForTask(ecs, workspaceTaskArn, "STOPPED");
      }
    });

    it("opens an ECS Exec session for an enabled running task", async () => {
      const taskDef = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family: `exec-smoke-${RUN_ID}`,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: "256",
          memory: "512",
          containerDefinitions: [
            {
              name: "app",
              image: "public.ecr.aws/docker/library/busybox:latest",
              essential: true,
              entryPoint: ["sh", "-c"],
              command: ["sleep 120"],
            },
          ],
        }),
      );
      const taskDefinition = required(
        taskDef.taskDefinition?.taskDefinitionArn,
        "taskDefinitionArn",
      );
      const run = await ecs.send(
        new RunTaskCommand({
          cluster: CLUSTER,
          taskDefinition,
          launchType: "FARGATE",
          enableExecuteCommand: true,
          networkConfiguration: {
            awsvpcConfiguration: { subnets: [subnetId], assignPublicIp: "DISABLED" },
          },
        }),
      );
      const taskArn = required(run.tasks?.[0]?.taskArn, "taskArn");
      try {
        await waitForTask(ecs, taskArn, "RUNNING");
        const out = await ecs.send(
          new ExecuteCommandCommand({
            cluster: CLUSTER,
            task: taskArn,
            container: "app",
            command: "echo hello",
            interactive: true,
          }),
        );

        expect(out.clusterArn).toBe(
          `arn:aws:ecs:${DEFAULT_AWS_REGION}:123456789012:cluster/${CLUSTER}`,
        );
        expect(out.containerArn).toBeTruthy();
        expect(out.containerName).toBe("app");
        expect(out.interactive).toBe(true);
        expect(out.taskArn).toBe(taskArn);
        expect(out.session?.sessionId).toBeTruthy();
        expect(out.session?.streamUrl).toContain("/ecs-exec/");
        expect(out.session?.tokenValue).toBeTruthy();
      } finally {
        await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: taskArn }));
        await waitForTask(ecs, taskArn, "STOPPED");
      }
    });
  },
);
