// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import {
  CreateScheduleCommand,
  type FlexibleTimeWindowMode,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import {
  CreateClusterCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EC2Client } from "@aws-sdk/client-ec2";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { dynamodbLocal, DEFAULT_AWS_REGION } from "@edd/config";
import { WorkspaceService } from "@edd/control-plane";
import { baseImage, ownerId, systemClock, workspaceId } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  awsSimClientConfig,
  configureAwsSimEnv,
  createVpcWithEgress,
  required,
  sleep,
} from "./aws-sim";

/**
 * Container-mode e2e: EventBridge Scheduler fires → ECS RunTask → real
 * reconciler Docker image runs one maintenance sweep → CloudWatch Logs.
 *
 * The sweep is NOT a no-op: a stale workspace (running golden-image task,
 * lastActivity backdated past the idle threshold) is seeded first, so the
 * reconciler must really select it, snapshot its managed volume, and stop the
 * ECS task — the full scale-to-zero path against real sim compute.
 *
 * Harness: docker-compose.e2e.yml (container-mode sockerless sim + DynamoDB
 * Local). The reconciler + workspace images must be built and accessible to
 * Docker before this test runs (see ci.yml `e2e` job).
 */

configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

// The reconciler image must be pre-built: `docker build -f services/reconciler/Dockerfile -t edd-reconciler:e2e .`
const RECONCILER_IMAGE = process.env.RECONCILER_IMAGE ?? "edd-reconciler:e2e";
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const RUN_ID = randomUUID().slice(0, 8);
const CLUSTER = `edd-reconciler-e2e-${RUN_ID}`;
const TABLE = `edd-reconciler-e2e-${RUN_ID}`;
const LOG_GROUP = `/edd/reconciler-e2e/${RUN_ID}`;
const FAKE_EBS_ROLE = "arn:aws:iam::000000000000:role/ecsInfrastructureRole";
// The golden image validates these at startup; the agent's heartbeats failing
// (TEST-NET control plane) is exactly the "user went away" idle scenario.
const UNREACHABLE_CP = "http://192.0.2.1:9";
const AGENT_SECRET = "f".repeat(64);
const SSH_CA_PUB = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca/ca.pub");
// Backdated past DEFAULT_IDLE_THRESHOLD_MS (30 min) so the sweep must stop it.
const STALE_BY_MS = 45 * 60 * 1000;

const SIM = awsSimClientConfig();

describe(
  "Reconciler container fired by EventBridge Scheduler (container-mode sim)",
  {
    timeout: 120_000,
  },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);
    const scheduler = new SchedulerClient(SIM);
    const cwLogs = new CloudWatchLogsClient(SIM);
    const dynamo = createDynamoClient();

    let taskDefArn: string;
    let clusterArn: string;
    let subnetId: string;
    let sgId: string;
    let staleWorkspaceId = "";
    let staleTaskArn = "";
    // A second seeded workspace whose task is killed OUT-OF-BAND before the
    // scheduler fires, so the reconciler CONTAINER's drift sweep must reconcile
    // it (exercising the containerized runMaintenance drift path, not just the
    // in-process reconciler covered by drift-recovery.e2e).
    let driftWorkspaceId = "";
    let driftTaskArn = "";

    const workspaceEntity = () => makeWorkspaceEntity(dynamo, TABLE);

    async function taskStatus(taskArn: string): Promise<string> {
      const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }));
      return required(out.tasks?.[0]?.lastStatus, "task lastStatus");
    }

    beforeAll(async () => {
      // Fresh DynamoDB table (no workspaces → reconciler sweeps 0 items).
      await dropTable(dynamo, TABLE);
      await ensureTable(dynamo, TABLE);

      // VPC + subnet + security group — sim enforces SG existence on RunTask.
      // The container-mode sim also models route-table egress: tasks need an
      // external route plus AssignPublicIp=ENABLED to reach host-side endpoints.
      const vpc = await createVpcWithEgress(ec2, {
        vpcCidr: "10.99.0.0/16",
        subnetCidr: "10.99.0.0/24",
        securityGroupName: `reconciler-e2e-sg-${RUN_ID}`,
      });
      subnetId = vpc.subnetId;
      sgId = vpc.securityGroupId;

      // ECS cluster.
      const clusterOut = await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
      clusterArn = required(clusterOut.cluster?.clusterArn, "clusterArn");

      // Seed a STALE workspace backed by a real golden-image task: created via
      // the real service + providers, then lastActivity backdated past the
      // idle threshold so the reconciler sweep must scale it to zero.
      const service = new WorkspaceService({
        workspaces: workspaceEntity(),
        storage: Ec2StorageProvider.fromEnv(),
        compute: new EcsComputeProvider({
          client: ecs,
          config: {
            cluster: CLUSTER,
            subnets: [subnetId],
            securityGroups: [sgId],
            ebsRoleArn: FAKE_EBS_ROLE,
            assignPublicIp: true,
            controlPlaneUrl: UNREACHABLE_CP,
            agentSecret: AGENT_SECRET,
            sshCaPublicKey: readFileSync(SSH_CA_PUB, "utf8").trim(),
          },
        }),
        clock: systemClock,
      });
      const ws = await service.create({
        ownerId: ownerId("stale-user"),
        baseImage: baseImage(WORKSPACE_IMAGE),
      });
      staleWorkspaceId = ws.id;
      const { data: seeded } = await workspaceEntity().get({ id: staleWorkspaceId }).go();
      staleTaskArn = required(seeded?.taskId, "seeded workspace taskId");
      const runningDeadline = Date.now() + 120_000;
      while ((await taskStatus(staleTaskArn)) !== "RUNNING") {
        if (Date.now() > runningDeadline) throw new Error("seeded workspace task never RUNNING");
        await sleep(2_000);
      }
      const staleActivity = new Date(Date.now() - STALE_BY_MS).toISOString();
      await workspaceEntity()
        .patch({ id: staleWorkspaceId })
        .set({ lastActivity: staleActivity })
        .go();

      // Seed a DRIFTED workspace: created + snapshotted, then its task is killed
      // out-of-band so the record still claims "running" with a dead task. The
      // reconciler container's drift sweep (runs FIRST in runMaintenance) must
      // reconcile it to "stopped" (a snapshot exists) and clear the bindings.
      const driftWs = await service.create({
        ownerId: ownerId("drift-user"),
        baseImage: baseImage(WORKSPACE_IMAGE),
      });
      driftWorkspaceId = driftWs.id;
      driftTaskArn = required(
        (await workspaceEntity().get({ id: driftWorkspaceId }).go()).data?.taskId,
        "drift workspace taskId",
      );
      const driftRunningDeadline = Date.now() + 120_000;
      while ((await taskStatus(driftTaskArn)) !== "RUNNING") {
        if (Date.now() > driftRunningDeadline) throw new Error("drift workspace task never RUNNING");
        await sleep(2_000);
      }
      // Snapshot so the drift outcome is the recoverable "stopped" (not "error").
      await service.snapshot(workspaceId(driftWorkspaceId));
      // Kill the task out-of-band — the control plane never hears about it.
      await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: driftTaskArn }));
      const driftDeadline = Date.now() + 120_000;
      while ((await taskStatus(driftTaskArn)) !== "STOPPED") {
        if (Date.now() > driftDeadline) throw new Error("drift task never stopped out-of-band");
        await sleep(2_000);
      }

      // Reconciler task definition.
      // Env wires the container to simulator-adjacent endpoints. The sim rewrites
      // host.docker.internal for netns tasks and enforces normal route-table egress.
      const tdOut = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family: `edd-reconciler-e2e-${RUN_ID}`,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: "256",
          memory: "512",
          containerDefinitions: [
            {
              name: "reconciler",
              image: RECONCILER_IMAGE,
              essential: true,
              environment: [
                { name: "AWS_ENDPOINT_URL", value: "http://host.docker.internal:4566" },
                { name: "DYNAMODB_ENDPOINT", value: "http://host.docker.internal:8000" },
                { name: "AWS_REGION", value: DEFAULT_AWS_REGION },
                { name: "AWS_ACCESS_KEY_ID", value: "test" },
                { name: "AWS_SECRET_ACCESS_KEY", value: "test" },
                { name: "DYNAMODB_TABLE", value: TABLE },
                { name: "ECS_CLUSTER", value: CLUSTER },
                { name: "ECS_SUBNETS", value: subnetId },
                { name: "ECS_EBS_ROLE_ARN", value: FAKE_EBS_ROLE },
              ],
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": LOG_GROUP,
                  "awslogs-region": DEFAULT_AWS_REGION,
                  "awslogs-stream-prefix": "reconciler",
                },
              },
            },
          ],
        }),
      );
      taskDefArn = required(tdOut.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");

      // EventBridge Scheduler: fire once, 3 seconds from now.
      const fireAt = new Date(Date.now() + 3_000).toISOString().replace(/\.\d+Z$/, "");
      await scheduler.send(
        new CreateScheduleCommand({
          Name: `reconciler-e2e-once-${RUN_ID}`,
          GroupName: "default",
          ScheduleExpression: `at(${fireAt})`,
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: "OFF" as FlexibleTimeWindowMode },
          ActionAfterCompletion: "DELETE",
          Target: {
            Arn: clusterArn,
            RoleArn: `arn:aws:iam::000000000000:role/scheduler`,
            EcsParameters: {
              TaskDefinitionArn: taskDefArn,
              TaskCount: 1,
              LaunchType: "FARGATE",
              NetworkConfiguration: {
                awsvpcConfiguration: {
                  Subnets: [subnetId],
                  SecurityGroups: [sgId],
                  AssignPublicIp: "ENABLED",
                },
              },
            },
          },
        }),
      );
    });

    afterAll(async () => {
      await dropTable(dynamo, TABLE);
    });

    it("scheduler fires the reconciler task and it runs to completion with exit 0", async () => {
      // The cluster also hosts the seeded workspace task, so match the
      // reconciler's own task definition among the stopped tasks.
      const deadline = Date.now() + 90_000;
      let reconcilerExit: number | undefined;

      while (Date.now() < deadline) {
        const listed = await ecs.send(
          new ListTasksCommand({ cluster: CLUSTER, desiredStatus: "STOPPED" }),
        );
        const arns = listed.taskArns ?? [];
        if (arns.length > 0) {
          const described = await ecs.send(
            new DescribeTasksCommand({ cluster: CLUSTER, tasks: arns }),
          );
          const reconcilerTask = described.tasks?.find((t) => t.taskDefinitionArn === taskDefArn);
          if (reconcilerTask) {
            reconcilerExit = reconcilerTask.containers?.[0]?.exitCode;
            break;
          }
        }
        await sleep(2_000);
      }
      expect(reconcilerExit, "reconciler container exit code").toBe(0);
    });

    it("the sweep stops the stale workspace's real ECS task and records its snapshot", async () => {
      const deadline = Date.now() + 90_000;
      while ((await taskStatus(staleTaskArn)) !== "STOPPED") {
        if (Date.now() > deadline) {
          throw new Error("stale workspace task was never stopped by the reconciler");
        }
        await sleep(2_000);
      }

      const { data } = await workspaceEntity().get({ id: staleWorkspaceId }).go();
      expect(data?.state).toBe("stopped");
      expect(data?.latestSnapshotId).toMatch(/^snap-/);
      expect(data?.taskId).toBeUndefined();
      expect(data?.volumeId).toBeUndefined();
    });

    it("the container's drift sweep reconciles the out-of-band-killed workspace", async () => {
      // The drift workspace's task was killed before the sweep; the containerized
      // runMaintenance drift pass must have reconciled the record to stopped
      // (snapshot present) and cleared its dead bindings.
      const deadline = Date.now() + 90_000;
      for (;;) {
        const { data } = await workspaceEntity().get({ id: driftWorkspaceId }).go();
        if (data?.state === "stopped") {
          expect(data.latestSnapshotId).toMatch(/^snap-/);
          expect(data.taskId).toBeUndefined();
          expect(data.volumeId).toBeUndefined();
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `drift workspace was not reconciled by the container (state: ${data?.state ?? "?"})`,
          );
        }
        await sleep(2_000);
      }
    });

    it("CloudTrail captures the RunTask event fired by the EventBridge Scheduler", async () => {
      const ctClient = new CloudTrailClient(SIM);
      const deadline = Date.now() + 30_000;
      let found = false;

      while (Date.now() < deadline) {
        const out = await ctClient.send(new LookupEventsCommand({ MaxResults: 50 }));
        found = (out.Events ?? []).some(
          (e) =>
            e.EventName === "RunTask" &&
            (e.Resources ?? []).some((r) => r.ResourceName?.includes(CLUSTER)),
        );
        if (found) break;
        await sleep(1_500);
      }

      expect(found, "CloudTrail must capture a RunTask event for the reconciler cluster").toBe(
        true,
      );
    });

    it("reconciler task emits a JSON maintenance-result line to CloudWatch Logs", async () => {
      const deadline = Date.now() + 30_000;
      let logLine: string | undefined;

      while (Date.now() < deadline) {
        const groups = await cwLogs.send(
          new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP }),
        );
        const groupExists = groups.logGroups?.some((g) => g.logGroupName === LOG_GROUP);
        if (groupExists) {
          // Stream name: "{prefix}/{containerName}/{taskId}" (auto-created by sim).
          const streams = await cwLogs.send(
            new DescribeLogStreamsCommand({
              logGroupName: LOG_GROUP,
              logStreamNamePrefix: "reconciler/reconciler",
            }),
          );
          const stream = streams.logStreams?.[0]?.logStreamName;
          if (stream) {
            const events = await cwLogs.send(
              new GetLogEventsCommand({ logGroupName: LOG_GROUP, logStreamName: stream }),
            );
            const found = events.events?.find(
              (e) => e.message?.includes('"idle"') && e.message.includes('"gc"'),
            );
            if (found) {
              logLine = found.message;
              break;
            }
          }
        }
        await sleep(1_500);
      }

      expect(logLine, "reconciler JSON output not found in CloudWatch Logs").toBeDefined();
      const result = JSON.parse(logLine ?? "{}") as Record<string, unknown>;
      expect(result).toHaveProperty("idle");
      expect(result).toHaveProperty("snapshots");
      expect(result).toHaveProperty("gc");
      // The sweep really scaled the seeded stale workspace to zero.
      expect(logLine).toContain('"stopped":1');
    });
  },
);
