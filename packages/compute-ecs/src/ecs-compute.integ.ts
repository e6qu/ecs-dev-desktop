// SPDX-License-Identifier: AGPL-3.0-or-later
import { CreateClusterCommand, ECSClient } from "@aws-sdk/client-ecs";
import { aws, DEFAULT_AWS_REGION } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";

import { EcsComputeProvider } from "./index";

// Point the AWS SDK at the sockerless AWS simulator (Tier-2 harness, from source).
process.env.AWS_ENDPOINT_URL ??= aws.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const CLUSTER = "edd-health-itest";
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";

/** Construct the provider against a given cluster (no real workspace launched). */
function providerFor(cluster: string): EcsComputeProvider {
  return new EcsComputeProvider({
    client: EcsComputeProvider.client(),
    config: { cluster, subnets: ["subnet-itest"], ebsRoleArn: EBS_ROLE },
  });
}

describe("EcsComputeProvider.health against the sockerless AWS sim", () => {
  beforeAll(async () => {
    await new ECSClient({
      region: process.env.AWS_REGION ?? DEFAULT_AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    }).send(new CreateClusterCommand({ clusterName: CLUSTER }));
  });

  it("reports ok when the ECS cluster is ACTIVE (live DescribeClusters)", async () => {
    const health = await providerFor(CLUSTER).health();
    expect(health.component).toBe("compute");
    expect(health.status).toBe("ok");
    expect(health.detail).toContain(CLUSTER);
  });

  it("reports degraded for a cluster that does not exist", async () => {
    const health = await providerFor("edd-no-such-cluster-itest").health();
    expect(health.component).toBe("compute");
    expect(health.status).toBe("degraded");
  });

  it("reports cluster info with live counts (DescribeClusters)", async () => {
    const info = await providerFor(CLUSTER).clusterInfo();
    expect(info.name).toBe(CLUSTER);
    expect(info.status).toBe("ACTIVE");
    // No workspaces launched in this suite — Fargate has no container instances.
    expect(info.runningTasks).toBe(0);
    expect(info.registeredContainerInstances).toBe(0);
  });

  it("reports a 'not found' cluster info without throwing", async () => {
    const info = await providerFor("edd-no-such-cluster-itest").clusterInfo();
    expect(info.name).toBe("edd-no-such-cluster-itest");
    expect(info.status).toBe("not found");
  });
});
