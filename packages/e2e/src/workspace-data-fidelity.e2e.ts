// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateClusterCommand,
  DescribeTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { volumeId } from "@edd/core";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { beforeAll, describe, expect, it } from "vitest";

import { configureAwsSimEnv, required, sleep } from "./aws-sim";

configureAwsSimEnv();

const CLUSTER = "edd-e2e";
const MARKER = "PERSISTED-edd-e2e";
const MOUNT = "/work";
const EBS_ROLE_ARN = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const IMAGE = "alpine:3.20";

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

  it("a 64 MiB payload survives snapshot → restore byte-for-byte (checksum)", async () => {
    // The marker test proves a tiny write round-trips; this proves real bulk
    // data does, with no silent corruption. The writer generates 64 MiB of
    // random bytes, records their sha256, and exits; the verifier recomputes
    // the digest against the restored volume (`sha256sum -c` → exit 0 only if
    // every byte matches). Random (not zeros) so a sparse/short read can't pass.
    await registerTask("edd-e2e-bigwriter", [
      "sh",
      "-c",
      `dd if=/dev/urandom of=${MOUNT}/big.bin bs=1M count=64 && sha256sum ${MOUNT}/big.bin > ${MOUNT}/big.sha && sync`,
    ]);
    const writer = await runTask("edd-e2e-bigwriter");
    const written = await waitFor(writer, "STOPPED");
    expect(written.containers?.[0]?.exitCode, "64 MiB write should succeed").toBe(0);

    const snap = await storage.createSnapshot(volumeId(managedVolumeId(written)));

    await registerTask("edd-e2e-bigverifier", ["sh", "-c", `cd ${MOUNT} && sha256sum -c big.sha`]);
    const verifier = await runTask("edd-e2e-bigverifier", snap.id);
    const stopped = await waitFor(verifier, "STOPPED");

    expect(
      stopped.containers?.[0]?.exitCode,
      "restored 64 MiB must match the recorded digest",
    ).toBe(0);
  });
});
