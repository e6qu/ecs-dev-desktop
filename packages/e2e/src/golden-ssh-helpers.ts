// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared plumbing for e2e that SSH into the golden workspace image over its
// managed-EBS awsvpc task: cert signing with the workspace CA, an in-subnet
// client task that runs a remote command, and task-status helpers. Used by the
// golden-workspace-ssh and data-durability suites.
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  DescribeTasksCommand,
  type ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { DEFAULT_AWS_REGION } from "@edd/config";

import { required, sleep } from "./aws-sim";

/** spawnSync wrapper returning a normalized status (-1 if the child never ran). */
export function run(cmd: string, args: string[]): { status: number; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stderr: res.stderr };
}

/** The exit code of a task's primary container (throws if absent). */
export function taskExitCode(task: Task): number {
  return required(task.containers?.[0]?.exitCode, "container exitCode");
}

/** Poll DescribeTasks until `arn` reaches `status`; fail fast if it stops while
 * we are waiting for RUNNING, or when the deadline passes. */
export async function waitForTask(
  ecs: ECSClient,
  cluster: string,
  arn: string,
  status: "RUNNING" | "STOPPED",
  timeoutMs = 180_000,
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [arn] }));
    const task = required(out.tasks?.[0], "task");
    if (task.lastStatus === status) return task;
    if (status === "RUNNING" && task.lastStatus === "STOPPED") {
      throw new Error(`task ${arn} stopped before RUNNING: ${task.stoppedReason ?? "?"}`);
    }
    await sleep(2_000);
  }
  throw new Error(`task ${arn} never reached ${status}`);
}

export interface SignedUserCert {
  privateKeyBase64: string;
  cert: string;
}

/** Generate a fresh ed25519 key at `userKey` and sign it with the workspace CA
 * at `caKey` for `principal`, returning the base64 private key + the cert. */
export function signWorkspaceCert(
  caKey: string,
  userKey: string,
  principal: string,
  identity: string,
): SignedUserCert {
  for (const p of [userKey, `${userKey}.pub`, `${userKey}-cert.pub`]) rmSync(p, { force: true });
  const keygen = run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    userKey,
    "-C",
    identity,
  ]);
  if (keygen.status !== 0) throw new Error(`ssh-keygen key failed: ${keygen.stderr}`);
  const signed = run("ssh-keygen", [
    "-s",
    caKey,
    "-I",
    identity,
    "-n",
    principal,
    "-V",
    "+1h",
    `${userKey}.pub`,
  ]);
  if (signed.status !== 0) throw new Error(`ssh-keygen sign failed: ${signed.stderr}`);
  return {
    privateKeyBase64: readFileSync(userKey).toString("base64"),
    cert: readFileSync(`${userKey}-cert.pub`, "utf8").trim(),
  };
}

export interface SshClientRun {
  cluster: string;
  subnetId: string;
  image: string;
  logGroup: string;
  /** Unique task-def family for this client invocation. */
  family: string;
  host: string;
  cred: SignedUserCert;
  /** Remote command to run as `workspace@host` once sshd answers. */
  remoteCmd: string;
  attempts?: number;
}

/**
 * Register + run an in-subnet client task that SSHes to `host` as `workspace`
 * with the signed cert and runs `remoteCmd`, retrying until sshd answers.
 * Returns the client task's exit code (0 ⇒ the remote command succeeded).
 */
export async function runSshClientTask(ecs: ECSClient, opts: SshClientRun): Promise<number> {
  const attempts = opts.attempts ?? 30;
  const script = [
    'printf "%s" "$SSH_PRIVATE_KEY_B64" | base64 -d > /tmp/id',
    'printf "%s\\n" "$SSH_CERT" > /tmp/id-cert.pub',
    "chmod 600 /tmp/id /tmp/id-cert.pub",
    `for i in $(seq 1 ${String(attempts)}); do`,
    `  ssh -i /tmp/id -o CertificateFile=/tmp/id-cert.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 workspace@${opts.host} "${opts.remoteCmd}" > /tmp/out 2>&1 && exit 0`,
    "  sleep 2",
    "done",
    "cat /tmp/out >&2",
    "exit 1",
  ].join("\n");
  const def = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: opts.family,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "256",
      memory: "512",
      containerDefinitions: [
        {
          name: "client",
          image: opts.image,
          essential: true,
          entryPoint: ["sh", "-c"],
          command: [script],
          environment: [
            { name: "SSH_PRIVATE_KEY_B64", value: opts.cred.privateKeyBase64 },
            { name: "SSH_CERT", value: opts.cred.cert },
          ],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": opts.logGroup,
              "awslogs-region": DEFAULT_AWS_REGION,
              "awslogs-stream-prefix": opts.family,
            },
          },
        },
      ],
    }),
  );
  const started = await ecs.send(
    new RunTaskCommand({
      cluster: opts.cluster,
      taskDefinition: required(def.taskDefinition?.taskDefinitionArn, "taskDefinitionArn"),
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: { subnets: [opts.subnetId], assignPublicIp: "DISABLED" },
      },
    }),
  );
  const arn = required(started.tasks?.[0]?.taskArn, "client taskArn");
  return taskExitCode(await waitForTask(ecs, opts.cluster, arn, "STOPPED"));
}
