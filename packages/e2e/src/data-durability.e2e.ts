// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DescribeTasksCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { CloudWatchLogsClient, CreateLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateClusterCommand } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { DEFAULT_AWS_REGION, dynamodbLocal } from "@edd/config";
import { WorkspaceService } from "@edd/control-plane";
import { baseImage, ownerId, systemClock, unwrap, workspaceId, workspacePrincipal } from "@edd/core";
import { createDynamoClient, dropTable, ensureTable, makeWorkspaceEntity } from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  awsSimClientConfig,
  configureAwsSimEnv,
  createVpcWithEgress,
  required,
  sleep,
} from "./aws-sim";

/**
 * Data durability across a REAL scale-to-zero cycle, driven through
 * WorkspaceService (not raw storage primitives like workspace-data-fidelity).
 *
 *   create golden workspace → SSH in, write a marker+checksum to /home/workspace
 *   (the managed-EBS mount) → service.stop() (snapshot via the control plane) →
 *   service.connect() (wake: a NEW task hydrates a fresh volume from that
 *   snapshot) → SSH into the woken task → the file is present and byte-identical.
 *
 * This proves the product's headline promise — your work survives scale-to-zero
 * — end to end through the lifecycle, with the data observed from inside the
 * workspace over SSH (the way a user reaches it), not just at the EBS API.
 */

configureAwsSimEnv();
process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

const RUN_ID = randomUUID().slice(0, 8);
const TABLE = `edd-durability-${RUN_ID}`;
const CLUSTER = `edd-durability-${RUN_ID}`;
const LOG_GROUP = `/edd/e2e/durability-${RUN_ID}`;
const WORKSPACE_IMAGE = "edd-workspace:e2e";
const EBS_ROLE = "arn:aws:iam::123456789012:role/ecsInfrastructureRole";
const AGENT_SECRET = "d2".repeat(32);
const CONTROL_PLANE_URL = "http://127.0.0.1:3000"; // idle-agent heartbeats fail harmlessly
const SUBNET_CIDR_RE = /^10\.76\.1\.\d+$/;
const SSH_ATTEMPTS = 30;

const SSH_CA_DIR = join(import.meta.dirname, "../../../services/ssh-gateway/temp/ssh-ca");
const CA_KEY = join(SSH_CA_DIR, "ca");
const CA_PUB = join(SSH_CA_DIR, "ca.pub");
const USER_KEY = join(SSH_CA_DIR, `durability-${RUN_ID}`);

const SIM = awsSimClientConfig();

function run(cmd: string, args: string[]): { status: number; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stderr: res.stderr };
}

function taskExitCode(task: Task): number {
  return required(task.containers?.[0]?.exitCode, "container exitCode");
}

describe("workspace data durability across scale-to-zero (real lifecycle)", { timeout: 600_000 }, () => {
  const ec2 = new EC2Client(SIM);
  const ecs = new ECSClient(SIM);
  let dynamo: ReturnType<typeof createDynamoClient>;
  let service: WorkspaceService;
  let subnetId: string;

  async function waitForTask(arn: string, status: "RUNNING" | "STOPPED"): Promise<Task> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [arn] }));
      const task = required(out.tasks?.[0], "task");
      if (task.lastStatus === status) return task;
      if (status === "RUNNING" && task.lastStatus === "STOPPED") {
        throw new Error(`task ${arn} stopped before RUNNING: ${task.stoppedReason ?? "?"}`);
      }
      await sleep(2_000);
    }
    throw new Error(`task ${arn} never reached ${status}`);
  }

  /** Sign a fresh user key with the workspace CA for `principal`. */
  function signUserCert(principal: string): { privateKeyBase64: string; cert: string } {
    for (const p of [USER_KEY, `${USER_KEY}.pub`, `${USER_KEY}-cert.pub`]) rmSync(p, { force: true });
    expect(run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", USER_KEY]).status).toBe(0);
    const signed = run("ssh-keygen", [
      "-s",
      CA_KEY,
      "-I",
      `edd-durability-${RUN_ID}`,
      "-n",
      principal,
      "-V",
      "+1h",
      `${USER_KEY}.pub`,
    ]);
    if (signed.status !== 0) throw new Error(`cert sign failed: ${signed.stderr}`);
    return {
      privateKeyBase64: readFileSync(USER_KEY).toString("base64"),
      cert: readFileSync(`${USER_KEY}-cert.pub`, "utf8").trim(),
    };
  }

  /** Run an in-subnet client task that SSHes to `host` and executes `remoteCmd`,
   * retrying until sshd answers. Returns the client task's exit code. */
  async function sshExec(
    label: string,
    host: string,
    cred: { privateKeyBase64: string; cert: string },
    remoteCmd: string,
  ): Promise<number> {
    const script = [
      'printf "%s" "$SSH_PRIVATE_KEY_B64" | base64 -d > /tmp/id',
      'printf "%s\\n" "$SSH_CERT" > /tmp/id-cert.pub',
      "chmod 600 /tmp/id /tmp/id-cert.pub",
      `for i in $(seq 1 ${String(SSH_ATTEMPTS)}); do`,
      `  ssh -i /tmp/id -o CertificateFile=/tmp/id-cert.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 workspace@${host} "${remoteCmd}" > /tmp/out 2>&1 && exit 0`,
      "  sleep 2",
      "done",
      "cat /tmp/out >&2",
      "exit 1",
    ].join("\n");
    const def = await ecs.send(
      new RegisterTaskDefinitionCommand({
        family: `durability-${label}-${RUN_ID}`,
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "client",
            image: WORKSPACE_IMAGE,
            essential: true,
            entryPoint: ["sh", "-c"],
            command: [script],
            environment: [
              { name: "SSH_PRIVATE_KEY_B64", value: cred.privateKeyBase64 },
              { name: "SSH_CERT", value: cred.cert },
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": LOG_GROUP,
                "awslogs-region": DEFAULT_AWS_REGION,
                "awslogs-stream-prefix": `durability-${label}`,
              },
            },
          },
        ],
      }),
    );
    const runOut = await ecs.send(
      new RunTaskCommand({
        cluster: CLUSTER,
        taskDefinition: required(def.taskDefinition?.taskDefinitionArn, "taskDefinitionArn"),
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: { subnets: [subnetId], assignPublicIp: "DISABLED" },
        },
      }),
    );
    const arn = required(runOut.tasks?.[0]?.taskArn, "client taskArn");
    return taskExitCode(await waitForTask(arn, "STOPPED"));
  }

  beforeAll(async () => {
    const vpc = await createVpcWithEgress(ec2, {
      vpcCidr: "10.76.0.0/16",
      subnetCidr: "10.76.1.0/24",
      securityGroupName: `durability-sg-${RUN_ID}`,
    });
    subnetId = vpc.subnetId;
    await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER }));
    await new CloudWatchLogsClient(SIM).send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }));

    dynamo = createDynamoClient();
    await dropTable(dynamo, TABLE);
    await ensureTable(dynamo, TABLE);
    service = new WorkspaceService({
      workspaces: makeWorkspaceEntity(dynamo, TABLE),
      storage: Ec2StorageProvider.fromEnv(),
      compute: new EcsComputeProvider({
        client: ecs,
        config: {
          cluster: CLUSTER,
          subnets: [subnetId],
          ebsRoleArn: EBS_ROLE,
          controlPlaneUrl: CONTROL_PLANE_URL,
          agentSecret: AGENT_SECRET,
          sshCaPublicKey: readFileSync(CA_PUB, "utf8").trim(),
          logGroupName: LOG_GROUP,
        },
      }),
      clock: systemClock,
    });
  });

  afterAll(async () => {
    await dropTable(dynamo, TABLE);
    for (const p of [USER_KEY, `${USER_KEY}.pub`, `${USER_KEY}-cert.pub`]) rmSync(p, { force: true });
  });

  it("a file written into a workspace survives stop → snapshot → wake", async () => {
    // 1. Create the workspace (real golden-image task + managed EBS).
    const ws = await service.create({
      ownerId: ownerId("durable-user"),
      baseImage: baseImage(WORKSPACE_IMAGE),
    });
    const created = await service.inspect(workspaceId(ws.id));
    const firstTask = required(created?.workspace.taskId, "taskId");
    const firstHost = required(created?.workspace.sshHost, "sshHost");
    expect(firstHost).toMatch(SUBNET_CIDR_RE);
    await waitForTask(firstTask, "RUNNING");

    // 2. SSH in and write a unique marker + its checksum to the managed mount.
    const cred = signUserCert(workspacePrincipal(ws.id));
    const marker = `edd-durable-${RUN_ID}-${randomUUID().slice(0, 8)}`;
    const writeExit = await sshExec(
      "writer",
      firstHost,
      cred,
      `printf %s '${marker}' > /home/workspace/persist.txt && sha256sum /home/workspace/persist.txt > /home/workspace/persist.sha && sync`,
    );
    expect(writeExit, "writing the marker over SSH should succeed").toBe(0);

    // 3. Scale to zero — the control plane snapshots the managed volume.
    const stopped = unwrap(await service.stop(workspaceId(ws.id)));
    expect(stopped.state).toBe("stopped");
    const stoppedDetail = await service.inspect(workspaceId(ws.id));
    expect(stoppedDetail?.workspace.latestSnapshotId).toMatch(/^snap-/);

    // 4. Wake — a NEW task hydrates a fresh volume from that snapshot.
    const woken = unwrap(await service.connect(workspaceId(ws.id)));
    expect(woken.state).toBe("running");
    const wokenDetail = await service.inspect(workspaceId(ws.id));
    const secondTask = required(wokenDetail?.workspace.taskId, "woken taskId");
    const secondHost = required(wokenDetail?.workspace.sshHost, "woken sshHost");
    expect(secondTask).not.toBe(firstTask);
    await waitForTask(secondTask, "RUNNING");

    // 5. SSH into the WOKEN task: the file is present and byte-identical.
    const verifyExit = await sshExec(
      "reader",
      secondHost,
      cred,
      `cd /home/workspace && sha256sum -c persist.sha && grep -q '${marker}' persist.txt`,
    );
    expect(verifyExit, "the marker must survive scale-to-zero byte-for-byte").toBe(0);

    await service.remove(workspaceId(ws.id));
  });
});
