// SPDX-License-Identifier: AGPL-3.0-or-later
import { baseImage } from "@edd/core";
import { describe, expect, it } from "vitest";

import {
  agentToken,
  taskDefinitionFamily,
  taskPrivateIp,
  workspaceEnvironment,
} from "./ecs-compute-provider";

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

describe("workspaceEnvironment", () => {
  it("injects workspace identity, heartbeat, and SSH CA variables", () => {
    const secret = "unit-test-agent-secret-not-sensitive";
    const env = workspaceEnvironment(
      {
        subnets: ["subnet-1"],
        ebsRoleArn: "arn:aws:iam::123456789012:role/ecsInfrastructureRole",
        controlPlaneUrl: "https://edd.example.test",
        agentSecret: secret,
        sshCaPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest edd-ca",
      },
      "ws-1",
    );

    expect(env).toEqual([
      { name: "EDD_WORKSPACE_ID", value: "ws-1" },
      { name: "EDD_CONTROL_PLANE_URL", value: "https://edd.example.test" },
      { name: "EDD_AGENT_TOKEN", value: agentToken(secret, "ws-1") },
      { name: "EDD_SSH_CA_PUBLIC_KEY", value: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest edd-ca" },
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
});
