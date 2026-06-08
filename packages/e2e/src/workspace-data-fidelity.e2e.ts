// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateClusterCommand,
  DescribeTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";
import { volumeId } from "@edd/core";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { beforeAll, describe, expect, it } from "vitest";

// Point the AWS SDK at the CONTAINER-MODE sockerless sim (docker-compose.e2e.yml).
process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

const CLUSTER = "edd-e2e";
const MARKER = "PERSISTED-edd-e2e";
const MOUNT = "/work";
const EBS_ROLE_ARN = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const IMAGE = "alpine:3.20";

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`missing ${field}`);
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("workspace data fidelity (write → snapshot → restore → read) on the sim", () => {
  const ecs = EcsComputeProvider.client();
  const storage = Ec2StorageProvider.fromEnv();

  beforeAll(async () => {
    await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
  });

  /** Register a Fargate task def that mounts a managed-EBS volume at /work. */
  async function registerTask(family: string, command: string[]): Promise<string> {
    const out = await ecs.send(
      new RegisterTaskDefinitionCommand({
        family,
        requiresCompatibilities: ["FARGATE"],
        networkMode: "none",
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "c",
            image: IMAGE,
            command,
            mountPoints: [{ sourceVolume: "work", containerPath: MOUNT }],
          },
        ],
        volumes: [{ name: "work", configuredAtLaunch: true }],
      }),
    );
    return required(out.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");
  }

  async function runTask(family: string, snapshotId?: string): Promise<string> {
    const out = await ecs.send(
      new RunTaskCommand({
        cluster: CLUSTER,
        taskDefinition: family,
        launchType: "FARGATE",
        volumeConfigurations: [
          {
            name: "work",
            managedEBSVolume: {
              roleArn: EBS_ROLE_ARN,
              ...(snapshotId === undefined ? { sizeInGiB: 8 } : { snapshotId }),
              terminationPolicy: { deleteOnTermination: false },
            },
          },
        ],
      }),
    );
    return required(out.tasks?.[0]?.taskArn, "taskArn");
  }

  async function waitFor(task: string, status: "RUNNING" | "STOPPED"): Promise<Task> {
    for (let i = 0; i < 60; i++) {
      const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [task] }));
      const t = required(out.tasks?.[0], "task");
      if (t.lastStatus === status) return t;
      await sleep(2000);
    }
    throw new Error(`task ${task} never reached ${status}`);
  }

  function managedVolumeId(task: Task): string {
    for (const a of task.attachments ?? []) {
      if (a.type !== "AmazonElasticBlockStorage") continue;
      for (const d of a.details ?? [])
        if (d.name === "volumeId") return required(d.value, "volumeId");
    }
    throw new Error("task has no managed EBS volume attachment");
  }

  it("a file written by a task survives snapshot → restore into a new task", async () => {
    // 1. A task writes a marker file to its retained managed EBS volume, syncs,
    // then exits cleanly. Snapshotting after STOPPED avoids a timing race where
    // the task has reached RUNNING but the write has not reached the mounted volume.
    await registerTask("edd-e2e-writer", ["sh", "-c", `echo ${MARKER} > ${MOUNT}/m.txt; sync`]);
    const writer = await runTask("edd-e2e-writer");
    const written = await waitFor(writer, "STOPPED");
    expect(written.containers?.[0]?.exitCode).toBe(0);
    const vol = managedVolumeId(written);

    // 2. Snapshot the retained volume via our real EBS adapter.
    const snap = await storage.createSnapshot(volumeId(vol));

    // 3. A new task hydrates a fresh volume from that snapshot and asserts the
    //    marker is present (exit 0) — proving the data round-tripped.
    await registerTask("edd-e2e-verifier", ["sh", "-c", `grep -q ${MARKER} ${MOUNT}/m.txt`]);
    const verifier = await runTask("edd-e2e-verifier", snap.id);
    const stopped = await waitFor(verifier, "STOPPED");

    expect(stopped.containers?.[0]?.exitCode).toBe(0);
  });
});
