// SPDX-License-Identifier: AGPL-3.0-or-later
import { baseImage } from "@edd/core";
import { describe, expect, it } from "vitest";

import {
  agentToken,
  taskDefinitionFamily,
  taskPrivateIp,
  taskReady,
  workspaceEnvironment,
} from "./ecs-compute-provider";

const eni = {
  type: "ElasticNetworkInterface",
  details: [{ name: "privateIPv4Address", value: "10.0.1.42" }],
};
const ebs = {
  type: "AmazonElasticBlockStorage",
  details: [{ name: "volumeId", value: "vol-abc123" }],
};

describe("taskDefinitionFamily", () => {
  it("derives a valid ECS family from a base-image reference", () => {
    expect(taskDefinitionFamily(baseImage("golden/node:20"))).toBe("edd-ws-golden-node-20");
  });

  it("replaces every character ECS families disallow", () => {
    expect(taskDefinitionFamily(baseImage("ghcr.io/acme/code:1.2"))).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});

describe("taskPrivateIp", () => {
  it("reads the IP from the ElasticNetworkInterface attachment details", () => {
    expect(
      taskPrivateIp({
        attachments: [
          {
            type: "ElasticNetworkInterface",
            details: [{ name: "privateIPv4Address", value: "10.0.1.42" }],
          },
        ],
      }),
    ).toBe("10.0.1.42");
  });

  it("falls back to containers[0].networkInterfaces[0].privateIpv4Address", () => {
    expect(
      taskPrivateIp({
        attachments: [],
        containers: [{ networkInterfaces: [{ privateIpv4Address: "10.0.1.99" }] }],
      }),
    ).toBe("10.0.1.99");
  });

  it("returns undefined when no IP is present", () => {
    expect(taskPrivateIp(undefined)).toBeUndefined();
    expect(taskPrivateIp({ attachments: [], containers: [] })).toBeUndefined();
  });

  it("ignores AmazonElasticBlockStorage attachments", () => {
    expect(
      taskPrivateIp({
        attachments: [
          {
            type: "AmazonElasticBlockStorage",
            details: [{ name: "privateIPv4Address", value: "10.0.1.1" }],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("taskReady", () => {
  it("is ready when RUNNING with the volume attached and an ENI IP", () => {
    expect(taskReady({ lastStatus: "RUNNING", attachments: [eni, ebs] })).toEqual({
      volumeId: "vol-abc123",
      sshHost: "10.0.1.42",
    });
  });

  it("is NOT ready while PROVISIONING/PENDING even with the volume + IP present", () => {
    expect(taskReady({ lastStatus: "PROVISIONING", attachments: [eni, ebs] })).toBeUndefined();
    expect(taskReady({ lastStatus: "PENDING", attachments: [eni, ebs] })).toBeUndefined();
  });

  it("is NOT ready when RUNNING but the ENI IP is not yet assigned", () => {
    expect(taskReady({ lastStatus: "RUNNING", attachments: [ebs] })).toBeUndefined();
  });

  it("is NOT ready when RUNNING but the managed volume is not yet attached", () => {
    expect(taskReady({ lastStatus: "RUNNING", attachments: [eni] })).toBeUndefined();
  });

  it("is NOT ready for a missing task", () => {
    expect(taskReady(undefined)).toBeUndefined();
  });
});

describe("workspaceEnvironment", () => {
  it("injects workspace identity and the agent token", () => {
    const secret = "unit-test-agent-secret-not-sensitive";
    const env = workspaceEnvironment(
      {
        subnets: ["subnet-1"],
        ebsRoleArn: "arn:aws:iam::123456789012:role/ecsInfrastructureRole",
        controlPlaneUrl: "https://edd.example.test",
        agentSecret: secret,
      },
      "ws-1",
    );

    expect(env).toEqual([
      { name: "EDD_WORKSPACE_ID", value: "ws-1" },
      { name: "EDD_CONTROL_PLANE_URL", value: "https://edd.example.test" },
      { name: "EDD_AGENT_TOKEN", value: agentToken(secret, "ws-1") },
    ]);
  });

  it("injects the heartbeat interval when configured (scale-to-zero tuning)", () => {
    const env = workspaceEnvironment(
      {
        subnets: ["subnet-1"],
        ebsRoleArn: "arn:aws:iam::123456789012:role/ecsInfrastructureRole",
        heartbeatIntervalS: 5,
      },
      "ws-2",
    );
    expect(env).toContainEqual({ name: "EDD_HEARTBEAT_INTERVAL_S", value: "5" });
  });

  it("omits the heartbeat interval when unset (image default applies)", () => {
    const env = workspaceEnvironment(
      { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/x" },
      "ws-3",
    );
    expect(env.map((e) => e.name)).not.toContain("EDD_HEARTBEAT_INTERVAL_S");
  });

  it("injects the repo URL + ref for a repo-bound session, and the git token never appears", () => {
    const env = workspaceEnvironment(
      { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/x" },
      "ws-4",
      { url: "https://github.com/acme/widgets.git", ref: "main" },
    );
    expect(env).toContainEqual({
      name: "EDD_REPO_URL",
      value: "https://github.com/acme/widgets.git",
    });
    expect(env).toContainEqual({ name: "EDD_REPO_REF", value: "main" });
    // The clone credential is brokered at boot, never placed in task metadata.
    expect(env.map((e) => e.name)).not.toContain("EDD_GIT_TOKEN");
  });

  it("omits repo vars for a blank/scratch session", () => {
    const env = workspaceEnvironment(
      { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/x" },
      "ws-5",
    );
    expect(env.map((e) => e.name)).not.toContain("EDD_REPO_URL");
    expect(env.map((e) => e.name)).not.toContain("EDD_REPO_REF");
  });
});
