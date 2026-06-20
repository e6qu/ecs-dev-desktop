// SPDX-License-Identifier: AGPL-3.0-or-later
import { CreateSubnetCommand, CreateVpcCommand, EC2Client } from "@aws-sdk/client-ec2";
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { baseImage } from "@edd/core";
import { computeProviderContract } from "@edd/core/compute/compute-provider-contract";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { beforeAll } from "vitest";

import { awsSimClientConfig, configureAwsSimEnv, e2eEbsRoleArn, required } from "./aws-sim";

// The shared ComputeProvider port contract against the REAL EcsComputeProvider on
// the CONTAINER-MODE sim — the only tier where a task actually reaches RUNNING
// (the process-mode integ tier has no container runtime). Running the same suite
// the fake passes (tier-1) here is what proves the fake's task-lifecycle +
// snapshot-hydration model matches real Fargate-managed EBS.
configureAwsSimEnv();

const CLUSTER = "edd-compute-contract";
// A long-running default CMD so the launched task stays RUNNING for observation.
const IMAGE = "nginx:alpine";
const SIM = awsSimClientConfig({ accessKeyId: "local", secretAccessKey: "local" });

let subnetId: string;

beforeAll(async () => {
  const ec2 = new EC2Client(SIM);
  const ecs = new ECSClient(SIM);
  const vpc = required((await ec2.send(new CreateVpcCommand({ CidrBlock: "10.0.0.0/16" }))).Vpc, "Vpc");
  const subnet = required(
    (await ec2.send(new CreateSubnetCommand({ VpcId: vpc.VpcId, CidrBlock: "10.0.1.0/24" }))).Subnet,
    "Subnet",
  );
  subnetId = required(subnet.SubnetId, "SubnetId");
  await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
});

computeProviderContract("EcsComputeProvider (container-mode sim)", () => {
  const storage = Ec2StorageProvider.fromEnv();
  return Promise.resolve({
    compute: new EcsComputeProvider({
      client: EcsComputeProvider.client(),
      config: { cluster: CLUSTER, subnets: [subnetId], ebsRoleArn: e2eEbsRoleArn() },
    }),
    baseImage: baseImage(IMAGE),
    // A real EBS snapshot the wake path can hydrate a managed volume from.
    makeSnapshot: async () => {
      const vol = await storage.createVolume();
      return (await storage.createSnapshot(vol.id)).id;
    },
  });
});
