// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateSubnetCommand,
  CreateVpcCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  CreateClusterCommand,
  DescribeTasksCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { describe, expect, it } from "vitest";

import { awsSimClientConfig, configureAwsSimEnv, required, sleep } from "./aws-sim";

configureAwsSimEnv();

const CLUSTER = "edd-overlap-vpc-e2e";
const IMAGE = "public.ecr.aws/docker/library/busybox:latest";
const OVERLAP_VPC_CIDR = "10.50.0.0/16";
const OVERLAP_SUBNET_CIDR = "10.50.0.0/24";
const OVERLAP_IP_PREFIX = "10.50.0.";
const SERVER_SCRIPT = "mkdir -p /www && echo ok > /www/index.html && httpd -f -p 80 -h /www";
const SAME_VPC_CLIENT_ATTEMPTS = 10;

const SIM = awsSimClientConfig();

function taskPrivateIp(task: Task): string {
  for (const container of task.containers ?? []) {
    for (const network of container.networkInterfaces ?? []) {
      if (network.privateIpv4Address !== undefined) return network.privateIpv4Address;
    }
  }
  for (const attachment of task.attachments ?? []) {
    if (attachment.type !== "ElasticNetworkInterface") continue;
    for (const detail of attachment.details ?? []) {
      if (detail.name === "privateIPv4Address" && detail.value !== undefined) return detail.value;
    }
  }
  throw new Error(`task ${task.taskArn ?? "(unknown)"} has no private IPv4 address`);
}

describe(
  "ECS awsvpc networking with overlapping VPC CIDRs (container-mode sim)",
  { timeout: 180_000 },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);

    async function createVpcSubnet(): Promise<{ vpcId: string; subnetId: string }> {
      const vpcOut = await ec2.send(new CreateVpcCommand({ CidrBlock: OVERLAP_VPC_CIDR }));
      const vpcId = required(vpcOut.Vpc?.VpcId, "VpcId");
      const subnetOut = await ec2.send(
        new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: OVERLAP_SUBNET_CIDR }),
      );
      return { vpcId, subnetId: required(subnetOut.Subnet?.SubnetId, "SubnetId") };
    }

    async function deleteVpcSubnet(ids: { vpcId: string; subnetId: string }): Promise<void> {
      await ec2.send(new DeleteSubnetCommand({ SubnetId: ids.subnetId }));
      await ec2.send(new DeleteVpcCommand({ VpcId: ids.vpcId }));
    }

    async function registerTask(family: string, script: string): Promise<string> {
      const out = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: "256",
          memory: "512",
          containerDefinitions: [
            {
              name: "app",
              image: IMAGE,
              essential: true,
              entryPoint: ["sh", "-c"],
              command: [script],
            },
          ],
        }),
      );
      return required(out.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");
    }

    async function runTask(taskDefinition: string, subnetId: string): Promise<string> {
      const out = await ecs.send(
        new RunTaskCommand({
          cluster: CLUSTER,
          taskDefinition,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: [subnetId],
              assignPublicIp: "DISABLED",
            },
          },
        }),
      );
      return required(out.tasks?.[0]?.taskArn, "taskArn");
    }

    async function describeTask(taskArn: string): Promise<Task> {
      const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }));
      return required(out.tasks?.[0], "task");
    }

    async function waitFor(taskArn: string, status: "RUNNING" | "STOPPED"): Promise<Task> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const task = await describeTask(taskArn);
        if (task.lastStatus === status) return task;
        if (status === "RUNNING" && task.lastStatus === "STOPPED") {
          throw new Error(
            `task ${taskArn} stopped before RUNNING: ${task.stoppedReason ?? "unknown"}`,
          );
        }
        await sleep(1_000);
      }
      throw new Error(`task ${taskArn} never reached ${status}`);
    }

    async function stopTask(taskArn: string): Promise<void> {
      await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: taskArn }));
      await waitFor(taskArn, "STOPPED");
    }

    it("keeps overlapping VPCs isolated while preserving real ENI CIDR addresses", async () => {
      await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));

      const startedTasks: string[] = [];
      const createdVpcs: { vpcId: string; subnetId: string }[] = [];

      async function createTrackedVpcSubnet(): Promise<{ vpcId: string; subnetId: string }> {
        const ids = await createVpcSubnet();
        createdVpcs.push(ids);
        return ids;
      }

      async function runTrackedTask(taskDefinition: string, subnetId: string): Promise<string> {
        const taskArn = await runTask(taskDefinition, subnetId);
        startedTasks.push(taskArn);
        return taskArn;
      }

      function forgetVpc(ids: { vpcId: string; subnetId: string }): void {
        const index = createdVpcs.findIndex((vpc) => vpc.vpcId === ids.vpcId);
        if (index >= 0) createdVpcs.splice(index, 1);
      }

      async function deleteTrackedVpcSubnet(ids: {
        vpcId: string;
        subnetId: string;
      }): Promise<void> {
        await deleteVpcSubnet(ids);
        forgetVpc(ids);
      }

      const serverTaskDef = await registerTask("overlap-server", SERVER_SCRIPT);
      const idleTaskDef = await registerTask("overlap-idle", "sleep 120");

      try {
        const vpcA = await createTrackedVpcSubnet();
        const vpcB = await createTrackedVpcSubnet();

        const serverA = await runTrackedTask(serverTaskDef, vpcA.subnetId);
        const idleB = await runTrackedTask(idleTaskDef, vpcB.subnetId);
        const runningServerA = await waitFor(serverA, "RUNNING");
        const runningIdleB = await waitFor(idleB, "RUNNING");

        const serverIp = taskPrivateIp(runningServerA);
        expect(serverIp).toMatch(/^10\.50\.0\.\d+$/);
        expect(taskPrivateIp(runningIdleB)).toMatch(/^10\.50\.0\.\d+$/);

        const sameVpcClientDef = await registerTask(
          "overlap-client-same-vpc",
          `for i in $(seq 1 ${SAME_VPC_CLIENT_ATTEMPTS}); do wget -T 3 -q -O - http://${serverIp}/index.html | grep -q ok && exit 0; sleep 1; done; exit 1`,
        );
        const crossVpcClientDef = await registerTask(
          "overlap-client-cross-vpc",
          `wget -T 3 -q -O - http://${serverIp}/index.html`,
        );

        const sameVpcClient = await runTrackedTask(sameVpcClientDef, vpcA.subnetId);
        const sameVpcStopped = await waitFor(sameVpcClient, "STOPPED");
        expect(required(sameVpcStopped.containers?.[0]?.exitCode, "sameVpc exitCode")).toBe(0);

        const crossVpcClient = await runTrackedTask(crossVpcClientDef, vpcB.subnetId);
        const crossVpcStopped = await waitFor(crossVpcClient, "STOPPED");
        expect(required(crossVpcStopped.containers?.[0]?.exitCode, "crossVpc exitCode")).not.toBe(
          0,
        );

        await stopTask(serverA);
        await deleteTrackedVpcSubnet(vpcA);

        const recreated = await createTrackedVpcSubnet();
        const recreatedTask = await runTrackedTask(idleTaskDef, recreated.subnetId);
        const recreatedRunning = await waitFor(recreatedTask, "RUNNING");
        expect(taskPrivateIp(recreatedRunning).startsWith(OVERLAP_IP_PREFIX)).toBe(true);
      } finally {
        for (const taskArn of [...startedTasks].reverse()) {
          const task = await describeTask(taskArn);
          if (task.lastStatus !== "STOPPED") await stopTask(taskArn);
        }
        for (const ids of [...createdVpcs].reverse()) {
          await deleteVpcSubnet(ids);
        }
      }
    });
  },
);
