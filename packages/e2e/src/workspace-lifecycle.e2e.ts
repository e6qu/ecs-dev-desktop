// SPDX-License-Identifier: AGPL-3.0-or-later
import { CreateSubnetCommand, CreateVpcCommand, EC2Client } from "@aws-sdk/client-ec2";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
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
});
