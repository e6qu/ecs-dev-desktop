// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type RunTaskCommandInput,
} from "@aws-sdk/client-ecs";
import { baseImage, deriveWorkspaceToken, snapshotId, taskId, workspaceId } from "@edd/core";
import { describe, expect, it } from "vitest";

import {
  agentToken,
  EcsComputeProvider,
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

  it("injects EDD_EDITOR_MODE only when an editor is chosen (default stays OpenVSCode)", () => {
    const config = {
      subnets: ["subnet-1"],
      ebsRoleArn: "arn:aws:iam::123456789012:role/ecsInfrastructureRole",
    };
    // No editor → no EDD_EDITOR_MODE (the container defaults to OpenVSCode).
    expect(workspaceEnvironment(config, "ws-1").some((e) => e.name === "EDD_EDITOR_MODE")).toBe(
      false,
    );
    // monaco → the env var the entrypoint branches on.
    const monaco = workspaceEnvironment(config, "ws-1", undefined, undefined, "monaco");
    expect(monaco).toContainEqual({ name: "EDD_EDITOR_MODE", value: "monaco" });
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

  it("injects the editor connection token (plaintext fallback) when a connection secret is set", () => {
    const secret = randomBytes(16).toString("hex");
    const env = workspaceEnvironment(
      {
        subnets: ["subnet-1"],
        ebsRoleArn: "arn:aws:iam::123456789012:role/x",
        connectionSecret: secret,
      },
      "ws-6",
    );
    expect(env).toContainEqual({
      name: "CONNECTION_TOKEN",
      value: deriveWorkspaceToken(secret, "ws-6"),
    });
  });

  it("omits each token from plaintext env when it is delivered via Secrets Manager", () => {
    const env = workspaceEnvironment(
      {
        subnets: ["subnet-1"],
        ebsRoleArn: "arn:aws:iam::123456789012:role/x",
        agentSecret: randomBytes(16).toString("hex"),
        connectionSecret: randomBytes(16).toString("hex"),
      },
      "ws-7",
      undefined,
      { omitAgentToken: true, omitConnectionToken: true },
    );
    expect(env.map((e) => e.name)).not.toContain("EDD_AGENT_TOKEN");
    expect(env.map((e) => e.name)).not.toContain("CONNECTION_TOKEN");
  });

  it("omits the connection token entirely when no connection secret is set (tokenless/dev)", () => {
    const env = workspaceEnvironment(
      { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/x" },
      "ws-8",
    );
    expect(env.map((e) => e.name)).not.toContain("CONNECTION_TOKEN");
  });
});

describe("EcsComputeProvider.runTask cleanup on a failed launch", () => {
  const LAUNCHED_ARN = "arn:aws:ecs:us-east-1:123456789012:task/edd/abc123";
  const RESOURCES = { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 } as const;

  /** A client whose launched task stops before becoming ready (so awaitTaskReady
   * throws), recording every StopTask issued so the test can assert cleanup. */
  function failingLaunchClient(stops: string[]): ECSClient {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof RegisterTaskDefinitionCommand) {
        return Promise.resolve({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:::task-definition/edd:1" },
        });
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({ tasks: [{ taskArn: LAUNCHED_ARN }] });
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [{ taskArn: LAUNCHED_ARN, lastStatus: "STOPPED", stoppedReason: "boot failed" }],
        });
      }
      if (command instanceof StopTaskCommand) {
        stops.push(command.input.task ?? "");
        return Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as ECSClient;
  }

  it("stops the launched task when it never becomes ready (no leaked Fargate task)", async () => {
    const stops: string[] = [];
    const provider = new EcsComputeProvider({
      client: failingLaunchClient(stops),
      config: { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/ebs" },
    });

    await expect(
      provider.runTask({
        workspaceId: workspaceId("ws-fail"),
        baseImage: baseImage("edd-workspace:e2e"),
        resources: RESOURCES,
      }),
    ).rejects.toThrow(/stopped before becoming ready/);

    // The launched task was stopped exactly once — the failed launch left nothing
    // running (its managed EBS volume is reaped by deleteOnTermination).
    expect(stops).toEqual([LAUNCHED_ARN]);
  });
});

// Assert the actual RunTask request shape — the security-critical bits a regression
// could silently drop: the `edd:workspace-id` tag (the orphan-task reaper enumerates
// + reads it back), FARGATE launch type, and the managed-EBS volume's
// `deleteOnTermination` + the fresh-vs-hydrate (sizeInGiB ↔ snapshotId) branch.
describe("EcsComputeProvider.runTask request shape (workspace tag + managed EBS + FARGATE)", () => {
  const ARN = "arn:aws:ecs:us-east-1:123456789012:task/edd/run1";
  const RESOURCES = { cpuUnits: 1024, memoryMiB: 4096, volumeGiB: 64 } as const;

  function capturingClient(runInputs: RunTaskCommandInput[]): ECSClient {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof RegisterTaskDefinitionCommand) {
        return Promise.resolve({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:::task-definition/edd:1" },
        });
      }
      if (command instanceof RunTaskCommand) {
        runInputs.push(command.input);
        return Promise.resolve({ tasks: [{ taskArn: ARN }] });
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [{ taskArn: ARN, lastStatus: "RUNNING", attachments: [eni, ebs] }],
        });
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as ECSClient;
  }

  const config = { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/ebs" };

  it("tags edd:workspace-id, runs FARGATE, sizes a fresh managed volume w/ deleteOnTermination", async () => {
    const runInputs: RunTaskCommandInput[] = [];
    const provider = new EcsComputeProvider({ client: capturingClient(runInputs), config });
    await provider.runTask({
      workspaceId: workspaceId("ws-1"),
      baseImage: baseImage("edd-workspace:e2e"),
      resources: RESOURCES,
    });
    const input = runInputs[0];
    expect(input?.launchType).toBe("FARGATE");
    expect(input?.tags).toContainEqual({ key: "edd:workspace-id", value: "ws-1" });
    expect(input?.networkConfiguration?.awsvpcConfiguration?.subnets).toEqual(["subnet-1"]);
    const vol = input?.volumeConfigurations?.[0]?.managedEBSVolume;
    expect(vol?.roleArn).toBe("arn:aws:iam::123456789012:role/ebs");
    expect(vol?.terminationPolicy?.deleteOnTermination).toBe(true);
    expect(vol?.sizeInGiB).toBe(64);
    expect(vol?.snapshotId).toBeUndefined();
  });

  it("hydrates the managed volume from a snapshot (snapshotId set, no sizeInGiB)", async () => {
    const runInputs: RunTaskCommandInput[] = [];
    const provider = new EcsComputeProvider({ client: capturingClient(runInputs), config });
    await provider.runTask({
      workspaceId: workspaceId("ws-2"),
      baseImage: baseImage("edd-workspace:e2e"),
      resources: RESOURCES,
      fromSnapshot: snapshotId("snap-xyz"),
    });
    const vol = runInputs[0]?.volumeConfigurations?.[0]?.managedEBSVolume;
    expect(vol?.snapshotId).toBe("snap-xyz");
    expect(vol?.sizeInGiB).toBeUndefined();
  });
});

describe("EcsComputeProvider.listWorkspaceTasks", () => {
  const WS_ARN = "arn:aws:ecs:us-east-1:123456789012:task/edd/ws1";
  const INFRA_ARN = "arn:aws:ecs:us-east-1:123456789012:task/edd/infra1";
  const started = new Date("2026-06-01T00:00:00.000Z");

  /** A client with two RUNNING tasks: one tagged workspace task and one untagged
   * infrastructure task (e.g. the control-plane) sharing the cluster. */
  function clusterClient(): ECSClient {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve({ taskArns: [WS_ARN, INFRA_ARN] });
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [
            {
              taskArn: WS_ARN,
              startedAt: started,
              tags: [{ key: "edd:workspace-id", value: "ws-1" }],
            },
            { taskArn: INFRA_ARN, startedAt: started, tags: [] },
          ],
        });
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as ECSClient;
  }

  it("returns only the tagged workspace task, with its workspace id + start time", async () => {
    const provider = new EcsComputeProvider({
      client: clusterClient(),
      config: { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/ebs" },
    });
    expect(await provider.listWorkspaceTasks()).toEqual([
      { id: WS_ARN, workspaceId: "ws-1", startedAt: started.toISOString() },
    ]);
  });
});

// RunTask returns HTTP 200 with an EMPTY tasks[] + a populated failures[] when
// placement fails for a recoverable reason (no Fargate capacity / ENI exhaustion). It
// does NOT throw, so reading tasks[0].taskArn would raise a misleading "missing taskArn".
describe("EcsComputeProvider.runTask placement failure (failures[])", () => {
  const RESOURCES = { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 } as const;
  function placementFailureClient(reason: string): ECSClient {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof RegisterTaskDefinitionCommand) {
        return Promise.resolve({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:::task-definition/edd:1" },
        });
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({ tasks: [], failures: [{ reason, detail: "no capacity" }] });
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as ECSClient;
  }

  it("surfaces the placement reason, not a generic 'missing taskArn'", async () => {
    const provider = new EcsComputeProvider({
      client: placementFailureClient("RESOURCE:MEMORY"),
      config: { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/ebs" },
    });
    await expect(
      provider.runTask({
        workspaceId: workspaceId("ws-cap"),
        baseImage: baseImage("edd-workspace:e2e"),
        resources: RESOURCES,
      }),
    ).rejects.toThrow(/RESOURCE:MEMORY/);
  });
});

// DescribeTasks returns a task either in tasks[] OR in failures[]. MISSING means the
// task is genuinely gone (the drift-loss condition → stopped); any OTHER failure reason
// is an API-level problem, not evidence of loss, so taskState must fail loud rather than
// silently report "stopped" (which would tear down a live workspace).
describe("EcsComputeProvider.taskState (DescribeTasks failures[])", () => {
  function describeFailureClient(failure: { reason?: string }): ECSClient {
    const send = (command: unknown): Promise<unknown> => {
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({ tasks: [], failures: [failure] });
      }
      return Promise.reject(new Error("unexpected command"));
    };
    return { send } as unknown as ECSClient;
  }
  const config = { subnets: ["subnet-1"], ebsRoleArn: "arn:aws:iam::123456789012:role/ebs" };

  it("treats a MISSING task as stopped (genuine loss)", async () => {
    const provider = new EcsComputeProvider({
      client: describeFailureClient({ reason: "MISSING" }),
      config,
    });
    expect(await provider.taskState(taskId("arn:aws:ecs:::task/edd/gone"))).toBe("stopped");
  });

  it("throws on a non-MISSING failure rather than reporting a live task stopped", async () => {
    const provider = new EcsComputeProvider({
      client: describeFailureClient({ reason: "ACCESSDENIED" }),
      config,
    });
    await expect(provider.taskState(taskId("arn:aws:ecs:::task/edd/x"))).rejects.toThrow(
      /unexpected failure: ACCESSDENIED/,
    );
  });
});
