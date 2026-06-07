// SPDX-License-Identifier: AGPL-3.0-or-later
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
} from "@aws-sdk/client-ecs";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { awsSim, dynamodbLocal, DEFAULT_AWS_REGION } from "@edd/config";
import { createDynamoClient, dropTable, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Container-mode e2e: EventBridge Scheduler fires → ECS RunTask → real
 * reconciler Docker image runs one maintenance sweep → CloudWatch Logs.
 *
 * Harness: docker-compose.e2e.yml (container-mode sockerless sim + DynamoDB
 * Local). The reconciler image must be built and accessible to Docker before
 * this test runs (see ci.yml `e2e` job).
 */

process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

// The reconciler image must be pre-built: `docker build -f services/reconciler/Dockerfile -t edd-reconciler:e2e .`
const RECONCILER_IMAGE = process.env.RECONCILER_IMAGE ?? "edd-reconciler:e2e";
const CLUSTER = "edd-reconciler-e2e";
const TABLE = "ecs-dev-desktop-reconciler-container-e2e";
const LOG_GROUP = "/edd/reconciler-e2e";
// Placeholder values — reconciler sweeps 0 workspaces so stopTask is never called.
const FAKE_SUBNET = "subnet-placeholder";
const FAKE_SG = "sg-placeholder";
const FAKE_EBS_ROLE = "arn:aws:iam::000000000000:role/ecsInfrastructureRole";

const SIM = {
  region: DEFAULT_AWS_REGION,
  endpoint: awsSim.endpoint,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

function req<T>(v: T | undefined, field: string): T {
  if (v === undefined) throw new Error(`missing ${field}`);
  return v;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe(
  "Reconciler container fired by EventBridge Scheduler (container-mode sim)",
  {
    timeout: 120_000,
  },
  () => {
    const ecs = new ECSClient(SIM);
    const scheduler = new SchedulerClient(SIM);
    const cwLogs = new CloudWatchLogsClient(SIM);
    const dynamo = createDynamoClient();

    let taskDefArn: string;
    let clusterArn: string;

    beforeAll(async () => {
      // Fresh DynamoDB table (no workspaces → reconciler sweeps 0 items).
      await dropTable(dynamo, TABLE);
      await ensureTable(dynamo, TABLE);

      // ECS cluster.
      const clusterOut = await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
      clusterArn = req(clusterOut.cluster?.clusterArn, "clusterArn");

      // Reconciler task definition.
      // Env wires the container to the sim via host.docker.internal — the
      // container-mode sim adds `host.docker.internal:host-gateway` to every task.
      const tdOut = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family: "edd-reconciler-e2e",
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
                { name: "ECS_SUBNETS", value: FAKE_SUBNET },
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
      taskDefArn = req(tdOut.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");

      // EventBridge Scheduler: fire once, 3 seconds from now.
      const fireAt = new Date(Date.now() + 3_000).toISOString().replace(/\.\d+Z$/, "");
      await scheduler.send(
        new CreateScheduleCommand({
          Name: "reconciler-e2e-once",
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
                  Subnets: [FAKE_SUBNET],
                  SecurityGroups: [FAKE_SG],
                  AssignPublicIp: "DISABLED",
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
      const deadline = Date.now() + 60_000;
      let stoppedTaskArn: string | undefined;

      while (Date.now() < deadline) {
        const listed = await ecs.send(
          new ListTasksCommand({ cluster: CLUSTER, desiredStatus: "STOPPED" }),
        );
        const firstArn = listed.taskArns?.[0];
        if (firstArn) {
          stoppedTaskArn = firstArn;
          break;
        }
        await sleep(2_000);
      }
      expect(stoppedTaskArn, "reconciler ECS task never stopped within 60s").toBeDefined();

      const described = await ecs.send(
        new DescribeTasksCommand({ cluster: CLUSTER, tasks: [stoppedTaskArn ?? ""] }),
      );
      const container = described.tasks?.[0]?.containers?.[0];
      expect(container?.exitCode, "reconciler container exit code").toBe(0);
    });

    // GATED on e6qu/sockerless#497: callJSONHandler (scheduler_firing.go:200) calls
    // handleECSRunTask directly via httptest.NewRequest, bypassing the POST / middleware in
    // main.go:102 that calls cloudTrailRecordAPICall. Scheduler-fired RunTask is never recorded.
    it.skip("CloudTrail captures the RunTask event fired by the EventBridge Scheduler", async () => {
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
    });
  },
);
