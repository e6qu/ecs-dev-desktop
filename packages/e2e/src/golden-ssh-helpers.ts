// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared plumbing for e2e that SSH into the golden workspace image over its
// managed-EBS awsvpc task: a registered-key pair, an in-subnet client task that
// runs a remote command, and task-status helpers. The caller registers the
// public key with the control plane (/api/ssh-keys); the golden image's
// AuthorizedKeysCommand authorizes it. Used by the golden-workspace-ssh and
// data-durability suites.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
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
function run(cmd: string, args: string[]): { status: number; stderr: string } {
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

export interface SshAuthorizeStub {
  /** Control-plane URL reachable from inside a sim task container (host alias + port). */
  controlPlaneUrl: string;
  stop: () => void;
}

/** The trimmed `publicKey` field of an ssh-authorize request body ("" if absent). */
function presentedKey(body: string): string {
  try {
    return ((JSON.parse(body) as { publicKey?: string }).publicKey ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * In-process stub control plane that authorizes exactly `publicKey` for any
 * workspace's `ssh-authorize` call — the golden image's AuthorizedKeysCommand hits
 * it (and harmlessly 200s the idle-agent heartbeat). The SSH itself runs inside a
 * sim task, so the host event loop stays free to serve (no worker thread needed,
 * unlike the spawnSync-based proxy e2e). `hostAlias` is the host as seen from a sim
 * container (from `hostReachableTarget`).
 */
export function startSshAuthorizeStub(
  publicKey: string,
  hostAlias: string,
): Promise<SshAuthorizeStub> {
  const want = publicKey.trim().split(/\s+/).slice(0, 2).join(" "); // "<type> <blob>"
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && (req.url ?? "").includes("/ssh-authorize")) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const pk = presentedKey(Buffer.concat(chunks).toString());
          res.writeHead(200);
          res.end(JSON.stringify(pk === want ? { authorized: true } : { authorized: false }));
        });
        return;
      }
      res.writeHead(200);
      res.end("{}");
    });
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        controlPlaneUrl: `http://${hostAlias}:${String(port)}`,
        stop: () => server.close(),
      });
    });
  });
}

export interface UserKeyPair {
  privateKeyBase64: string;
  /** OpenSSH public key line to register with the control plane (/api/ssh-keys). */
  publicKey: string;
}

/** Generate a fresh ed25519 key at `userKey`, returning the base64 private key +
 * the public-key line the caller registers with the control plane. */
export function generateUserKey(userKey: string, identity: string): UserKeyPair {
  mkdirSync(dirname(userKey), { recursive: true });
  for (const p of [userKey, `${userKey}.pub`]) rmSync(p, { force: true });
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
  return {
    privateKeyBase64: readFileSync(userKey).toString("base64"),
    publicKey: readFileSync(`${userKey}.pub`, "utf8").trim(),
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
  /** base64 of the registered key's private half (its public half is registered). */
  privateKeyBase64: string;
  /** Remote command to run as `workspace@host` once sshd answers. */
  remoteCmd: string;
  attempts?: number;
}

/**
 * Register + run an in-subnet client task that SSHes to `host` as `workspace`
 * with the registered key and runs `remoteCmd`, retrying until sshd answers (and
 * the golden image's AuthorizedKeysCommand authorizes the key). Returns the client
 * task's exit code (0 ⇒ the remote command succeeded).
 */
export async function runSshClientTask(ecs: ECSClient, opts: SshClientRun): Promise<number> {
  const attempts = opts.attempts ?? 30;
  const script = [
    'printf "%s" "$SSH_PRIVATE_KEY_B64" | base64 -d > /tmp/id',
    "chmod 600 /tmp/id",
    `for i in $(seq 1 ${String(attempts)}); do`,
    `  ssh -i /tmp/id -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 workspace@${opts.host} "${opts.remoteCmd}" > /tmp/out 2>&1 && exit 0`,
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
          environment: [{ name: "SSH_PRIVATE_KEY_B64", value: opts.privateKeyBase64 }],
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
