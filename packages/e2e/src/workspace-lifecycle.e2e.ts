// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { CreateSubnetCommand, CreateVpcCommand, EC2Client } from "@aws-sdk/client-ec2";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { CloudTrailAuditSource } from "@edd/cloudtrail-audit";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the SDKs at the CONTAINER-MODE sim (ECS/EC2) + DynamoDB Local.
process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const TABLE = "ecs-dev-desktop-e2e-lifecycle";
const CLUSTER = "edd-workspaces";
const IMAGE = "nginx:alpine"; // long-running default CMD, so the task stays RUNNING
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";

const SIM = {
  region: DEFAULT_AWS_REGION,
  endpoint: awsSim.endpoint,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function req<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`missing ${field}`);
  return value;
}

describe("workspace lifecycle through WorkspaceService on the sim (real ECS + EBS)", () => {
  let dynamo: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;

  beforeAll(async () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);

    const vpc = req(
      (await ec2.send(new CreateVpcCommand({ CidrBlock: "10.0.0.0/16" }))).Vpc,
      "Vpc",
    );
    const subnet = req(
      (await ec2.send(new CreateSubnetCommand({ VpcId: vpc.VpcId, CidrBlock: "10.0.1.0/24" })))
        .Subnet,
      "Subnet",
    );
    await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));

    dynamo = createDynamoClient();
    await dropTable(dynamo, TABLE);
    await ensureTable(dynamo, TABLE);

    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(dynamo, TABLE),
      storage: Ec2StorageProvider.fromEnv(),
      compute: new EcsComputeProvider({
        client: EcsComputeProvider.client(),
        config: {
          cluster: CLUSTER,
          subnets: [req(subnet.SubnetId, "SubnetId")],
          ebsRoleArn: EBS_ROLE,
        },
      }),
      clock: systemClock,
    });
  });

  afterAll(async () => {
    await dropTable(dynamo, TABLE);
  });

  it("runs create → stop (snapshot) → start (restore) → remove on real Fargate + managed EBS", async () => {
    const ws = await service.create({ ownerId: ownerId("e2e"), baseImage: baseImage(IMAGE) });
    expect(ws.state).toBe("running");

    // sshHost is the ENI private IP read from DescribeTasks. Verify it is in the
    // VPC subnet CIDR (10.0.1.0/24 from beforeAll).
    const detail = await service.inspect(workspaceId(ws.id));
    expect(detail?.workspace.sshHost, "sshHost should be set to the task's ENI IP").toBeDefined();
    expect(detail?.workspace.sshHost).toMatch(/^10\.0\.1\.\d+$/);

    // scale-to-zero: snapshot the managed volume, stop the task (ECS releases it)
    const stopped = unwrap(await service.stop(workspaceId(ws.id)));
    expect(stopped.state).toBe("stopped");

    // wake-on-connect: an incoming connection wakes the workspace — a new task
    // hydrates a fresh managed volume from the snapshot (real ECS + EBS).
    const woken = unwrap(await service.connect(workspaceId(ws.id)));
    expect(woken.state).toBe("running");
    expect(woken.id).toBe(ws.id);

    // idempotent: connecting again to the running workspace does not restart it.
    const again = unwrap(await service.connect(workspaceId(ws.id)));
    expect(again.state).toBe("running");

    expect((await service.remove(workspaceId(ws.id))).ok).toBe(true);
    expect(await service.get(workspaceId(ws.id))).toBeNull();
  });

  it("CloudTrail captures RunTask, StopTask, and CreateSnapshot from the workspace lifecycle", async () => {
    const ctClient = new CloudTrailClient(SIM);
    const ctSrc = CloudTrailAuditSource.fromEnv();

    // Create a workspace: WorkspaceService → EcsComputeProvider.runTask → ECS RunTask API.
    const ws = await service.create({ ownerId: ownerId("e2e-ct"), baseImage: baseImage(IMAGE) });
    expect(ws.state).toBe("running");

    async function pollForEvent(eventName: string, timeoutMs = 30_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const out = await ctClient.send(new LookupEventsCommand({ MaxResults: 100 }));
        if ((out.Events ?? []).some((e) => e.EventName === eventName)) return true;
        await sleep(1_000);
      }
      return false;
    }

    expect(
      await pollForEvent("RunTask"),
      "CloudTrail must capture RunTask after workspace.create()",
    ).toBe(true);

    // Stop: snapshots the EBS volume (CreateSnapshot) then stops the task (StopTask).
    unwrap(await service.stop(workspaceId(ws.id)));

    expect(
      await pollForEvent("StopTask"),
      "CloudTrail must capture StopTask after workspace.stop()",
    ).toBe(true);
    expect(
      await pollForEvent("CreateSnapshot"),
      "CloudTrail must capture CreateSnapshot after workspace.stop()",
    ).toBe(true);

    // CloudTrailAuditSource.recent() must also surface these same operations.
    const auditEvents = await ctSrc.recent(100);
    expect(
      auditEvents.some((e) => e.action === "RunTask"),
      "CloudTrailAuditSource.recent() must include RunTask",
    ).toBe(true);
    expect(
      auditEvents.some((e) => e.action === "StopTask"),
      "CloudTrailAuditSource.recent() must include StopTask",
    ).toBe(true);
    expect(
      auditEvents.some((e) => e.action === "CreateSnapshot"),
      "CloudTrailAuditSource.recent() must include CreateSnapshot",
    ).toBe(true);

    await service.remove(workspaceId(ws.id));
  });
});
