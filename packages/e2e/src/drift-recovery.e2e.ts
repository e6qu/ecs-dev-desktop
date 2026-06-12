// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import {
  CreateClusterCommand,
  DescribeTasksCommand,
  ECSClient,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { WorkspaceService } from "@edd/control-plane";
import { baseImage, ownerId, systemClock, unwrap, workspaceId } from "@edd/core";
import {
  createDynamoClient,
  dropTable,
  dynamodbLocal,
  ensureTable,
  makeWorkspaceEntity,
} from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { Reconciler } from "@edd/reconciler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  awsSimClientConfig,
  configureAwsSimEnv,
  createVpcWithEgress,
  required,
  sleep,
} from "./aws-sim";

/**
 * Drift detection e2e on REAL sim compute: a workspace task is killed
 * OUT-OF-BAND (raw ECS StopTask — a crash/eviction stand-in the control plane
 * never hears about), so the record keeps claiming live bindings. The
 * reconciler's drift sweep must notice via DescribeTasks and transition the
 * record honestly: `stopped` (wake-able) when a snapshot exists, `error` when
 * nothing can be restored. Before this sweep existed, connect-info would hand
 * the SSH gateway a dead ENI IP and the idle sweep would crash snapshotting
 * the released volume.
 */

configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const TABLE = `edd-drift-${RUN_ID}`;
const CLUSTER = `edd-drift-${RUN_ID}`;
const IMAGE = "nginx:alpine"; // long-running default CMD, so the task stays RUNNING
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";

const SIM = awsSimClientConfig();

describe("reconciler drift detection on real sim compute", { timeout: 600_000 }, () => {
  const ecs = new ECSClient(SIM);
  let dynamo: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let reconciler: Reconciler;
  let storage: Ec2StorageProvider;

  async function killTaskOutOfBand(arn: string): Promise<void> {
    await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: arn }));
    const deadline = Date.now() + 120_000;
    for (;;) {
      const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [arn] }));
      if (required(out.tasks?.[0]?.lastStatus, "lastStatus") === "STOPPED") return;
      if (Date.now() > deadline) throw new Error("task never stopped");
      await sleep(2_000);
    }
  }

  beforeAll(async () => {
    const vpc = await createVpcWithEgress(new EC2Client(SIM), {
      vpcCidr: "10.75.0.0/16",
      subnetCidr: "10.75.1.0/24",
      securityGroupName: `drift-sg-${RUN_ID}`,
    });
    await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));

    dynamo = createDynamoClient();
    await dropTable(dynamo, TABLE);
    await ensureTable(dynamo, TABLE);

    storage = Ec2StorageProvider.fromEnv();
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(dynamo, TABLE),
      storage,
      compute: new EcsComputeProvider({
        client: EcsComputeProvider.client(),
        config: {
          cluster: CLUSTER,
          subnets: [vpc.subnetId],
          securityGroups: [vpc.securityGroupId],
          ebsRoleArn: EBS_ROLE,
        },
      }),
      clock: systemClock,
    });
    reconciler = new Reconciler({ service, storage, clock: systemClock });
  });

  afterAll(async () => {
    await dropTable(dynamo, TABLE);
  });

  it("snapshot-backed loss → stopped, then connect() wakes a fresh task", async () => {
    const ws = await service.create({ ownerId: ownerId("drift-a"), baseImage: baseImage(IMAGE) });
    unwrap(await service.snapshot(workspaceId(ws.id)));
    const bound = await service.inspect(workspaceId(ws.id));
    const deadTask = required(bound?.workspace.taskId, "taskId");

    await killTaskOutOfBand(deadTask);

    // The record still claims live bindings — exactly the drift to detect.
    const before = await service.get(workspaceId(ws.id));
    expect(before?.state).toBe("running");

    const result = await reconciler.runMaintenance();
    expect(result.drift.lost).toBe(1);

    const after = await service.inspect(workspaceId(ws.id));
    expect(after?.workspace.state).toBe("stopped");
    expect(after?.workspace.taskId).toBeUndefined();
    expect(after?.workspace.sshHost).toBeUndefined();
    expect(after?.workspace.latestSnapshotId).toMatch(/^snap-/);

    // Recovery: wake-on-connect hydrates a NEW task from the snapshot.
    const woken = unwrap(await service.connect(workspaceId(ws.id)));
    expect(woken.state).toBe("running");
    const rebound = await service.inspect(workspaceId(ws.id));
    expect(rebound?.workspace.taskId).toBeDefined();
    expect(rebound?.workspace.taskId).not.toBe(deadTask);
    await service.stop(workspaceId(ws.id)); // teardown the woken task
  });

  it("snapshot-less loss → error, and connect() refuses honestly", async () => {
    const ws = await service.create({ ownerId: ownerId("drift-b"), baseImage: baseImage(IMAGE) });
    const bound = await service.inspect(workspaceId(ws.id));
    await killTaskOutOfBand(required(bound?.workspace.taskId, "taskId"));

    const result = await reconciler.runMaintenance();
    expect(result.drift.lost).toBe(1);

    const after = await service.inspect(workspaceId(ws.id));
    expect(after?.workspace.state).toBe("error");
    expect(after?.workspace.taskId).toBeUndefined();

    const connect = await service.connect(workspaceId(ws.id));
    expect(connect.ok).toBe(false);
    if (!connect.ok) expect(connect.error.kind).toBe("conflict");
  });

  it("a healthy running workspace is left untouched by the drift sweep", async () => {
    const ws = await service.create({ ownerId: ownerId("drift-c"), baseImage: baseImage(IMAGE) });
    const result = await reconciler.detectDrift();
    expect(result.lost).toBe(0);
    const after = await service.get(workspaceId(ws.id));
    expect(after?.state).toBe("running");
    await service.stop(workspaceId(ws.id));
  });
});
