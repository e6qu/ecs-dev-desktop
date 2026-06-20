// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { EC2Client } from "@aws-sdk/client-ec2";
import {
  CreateClusterCommand as CreateEcsClusterCommand,
  DescribeTasksCommand,
  ECSClient,
  ExecuteCommandCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { EcsComputeProvider } from "@edd/compute-ecs";
import { DEFAULT_AWS_REGION, DEFAULT_WORKSPACE_PORT as WORKSPACE_PORT } from "@edd/config";
import { baseImage, workspaceId } from "@edd/core";
import { beforeAll, describe, expect, it } from "vitest";

import {
  awsSimClientConfig,
  configureAwsSimEnv,
  createVpcWithEgress,
  e2eEbsRoleArn,
  e2eWorkspaceImage,
  required,
  sleep,
} from "./aws-sim";
import { hostReachableTarget } from "./docker-host";
import { generateUserKey, startSshAuthorizeStub, taskExitCode } from "./golden-ssh-helpers";

configureAwsSimEnv();

const RUN_ID = randomUUID().slice(0, 8);
const CLUSTER = `edd-golden-ssh-${RUN_ID}`;
const VPC_CIDR = "10.71.0.0/16";
const SUBNET_CIDR = "10.71.1.0/24";
const WORKSPACE_IMAGE = e2eWorkspaceImage();
const CLIENT_CONTAINER = "client";
const WORKSPACE_CONTAINER = "workspace";
const WORKSPACE_ID = `ws-golden-${RUN_ID}`;
const LOG_GROUP = `/edd/e2e/golden-ssh-${RUN_ID}`;
const EBS_ROLE = e2eEbsRoleArn();
const AGENT_SECRET = "a".repeat(64);
const SSH_ATTEMPTS = 30;
/** Editor poll budget (phase 2): OpenVSCode accepts TCP early but is slow to
 * actually serve its token gate in the sim, so it gets a longer, separate budget. */
const OPENVSCODE_ATTEMPTS = 45;
/** STOPPED-wait for the SSH client task: must cover both decoupled phases
 * (~SSH_ATTEMPTS + OPENVSCODE_ATTEMPTS polls) with headroom under the describe
 * timeout — the prior 180s default fired mid-loop and read as "never STOPPED". */
const CLIENT_STOP_TIMEOUT_MS = 260_000;
const ECS_EXEC_MARKER = `edd-ecs-exec-${RUN_ID}`;
const ECS_EXEC_TIMEOUT_MS = 15_000;
const SSM_MESSAGE_SCHEMA_VERSION = "1.0";
const USER_KEY = join(
  import.meta.dirname,
  "../../../services/ssh-gateway/temp/ssh-ca",
  `golden-${RUN_ID}`,
);

const SIM = awsSimClientConfig();

interface ExecMessageEvent {
  readonly data: string | ArrayBuffer | Blob;
}

function isExecMessageEvent(value: unknown): value is ExecMessageEvent {
  if (value === null || typeof value !== "object" || !("data" in value)) return false;
  const data = value.data;
  return typeof data === "string" || data instanceof ArrayBuffer || data instanceof Blob;
}

async function execMessageText(data: string | ArrayBuffer | Blob): Promise<string> {
  if (typeof data === "string") return data;
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  return new TextDecoder().decode(bytes);
}

async function readExecOutput(streamUrl: string, tokenValue: string): Promise<string> {
  const socket = new WebSocket(streamUrl);
  socket.binaryType = "arraybuffer";

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (result: { output: string } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      if ("error" in result) reject(result.error);
      else resolve(result.output);
    };
    const timeout = setTimeout(() => {
      finish({
        error: new Error(
          `ECS Exec data channel did not return ${ECS_EXEC_MARKER} within ${String(ECS_EXEC_TIMEOUT_MS)}ms; output: ${output}`,
        ),
      });
    }, ECS_EXEC_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (settled) {
        socket.close();
        return;
      }
      socket.send(
        JSON.stringify({
          MessageSchemaVersion: SSM_MESSAGE_SCHEMA_VERSION,
          RequestId: randomUUID(),
          TokenValue: tokenValue,
          ClientId: randomUUID(),
        }),
      );
    });
    socket.addEventListener("message", (event: unknown) => {
      if (!isExecMessageEvent(event)) {
        finish({ error: new Error("ECS Exec data channel returned an unsupported message") });
        return;
      }
      void execMessageText(event.data)
        .then((text) => {
          output += text;
          if (output.includes(ECS_EXEC_MARKER)) finish({ output });
        })
        .catch((error: unknown) => {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
        });
    });
    socket.addEventListener("error", () => {
      finish({ error: new Error("ECS Exec data channel failed to open") });
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        finish({
          error: new Error(`ECS Exec data channel closed before command output; output: ${output}`),
        });
      }
    });
  });
}

async function waitForTask(
  ecs: ECSClient,
  taskArn: string,
  status: "RUNNING" | "STOPPED",
  timeoutMs = 180_000,
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }));
    const task = required(out.tasks?.[0], "task");
    if (task.lastStatus === status) return task;
    if (status === "RUNNING" && task.lastStatus === "STOPPED") {
      throw new Error(`task ${taskArn} stopped before RUNNING: ${task.stoppedReason ?? "unknown"}`);
    }
    await sleep(1_000);
  }
  throw new Error(`task ${taskArn} never reached ${status}`);
}

describe(
  "golden workspace image against the container-mode AWS simulator",
  // Headroom for the worst case: workspace launch + the client task's two-phase
  // poll (CLIENT_STOP_TIMEOUT_MS) + teardown. The success path is far faster.
  { timeout: 360_000 },
  () => {
    const ec2 = new EC2Client(SIM);
    const ecs = new ECSClient(SIM);
    const logs = new CloudWatchLogsClient(SIM);
    let subnetId: string;

    beforeAll(async () => {
      // The workspace task authorizes SSH keys by calling the control plane
      // (AuthorizedKeysCommand → ssh-authorize), so its subnet needs egress to
      // reach it — same as any real deployment where a task talks to the control
      // plane. A plain VPC with no route out would deny every key.
      const vpc = await createVpcWithEgress(ec2, {
        vpcCidr: VPC_CIDR,
        subnetCidr: SUBNET_CIDR,
        securityGroupName: `golden-ssh-sg-${RUN_ID}`,
      });
      subnetId = vpc.subnetId;
      await ecs.send(new CreateEcsClusterCommand({ clusterName: CLUSTER }));
      await logs.send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }));
    });

    async function runWorkspaceTask(controlPlaneUrl: string): Promise<{
      taskArn: string;
      sshHost: string;
    }> {
      const compute = new EcsComputeProvider({
        client: ecs,
        config: {
          cluster: CLUSTER,
          subnets: [subnetId],
          ebsRoleArn: EBS_ROLE,
          // The workspace must reach the control plane to authorize SSH keys
          // (AuthorizedKeysCommand → ssh-authorize), so it needs a public IP +
          // the subnet's egress route — a public-subnet task, like `data-durability`
          // (whose default is ENABLED). With no public IP every key is denied.
          assignPublicIp: true,
          containerName: WORKSPACE_CONTAINER,
          controlPlaneUrl,
          agentSecret: AGENT_SECRET,
          logGroupName: LOG_GROUP,
        },
      });
      const task = await compute.runTask({
        workspaceId: workspaceId(WORKSPACE_ID),
        baseImage: baseImage(WORKSPACE_IMAGE),
      });
      return { taskArn: task.id, sshHost: required(task.sshHost, "sshHost") };
    }

    async function registerClientTask(host: string, privateKeyBase64: string): Promise<string> {
      const sshOpts =
        "-i /tmp/id -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3";
      // Two decoupled phases: prove the registered key authorizes (SSH lands us on
      // the workspace), THEN poll OpenVSCode until it warms up. Coupling them into a
      // single retry — re-running SSH on every editor poll — let one slow signal
      // (the editor takes a while to serve in the sim) stall behind the other and
      // overrun the task-stop deadline; decoupled, each exits as soon as it is met.
      const script = [
        'printf "%s" "$SSH_PRIVATE_KEY_B64" | base64 -d > /tmp/id',
        "chmod 600 /tmp/id",
        // Phase 1 — registered-key SSH authorize → we are `workspace` on the node.
        "authorized=",
        `for i in $(seq 1 ${SSH_ATTEMPTS}); do`,
        `  if ssh ${sshOpts} workspace@${host} whoami 2>/tmp/err | grep -q '^workspace$'; then authorized=1; break; fi`,
        "  sleep 2",
        "done",
        'if [ -z "$authorized" ]; then echo "ssh never authorized:" >&2; cat /tmp/err >&2; exit 1; fi',
        'echo "registered-key SSH authorized" >&2',
        // Phase 2 — the SAME awsvpc task serves OpenVSCode on :3000; with no
        // connection token it answers 403 (its token gate) — proof the editor HTTP
        // service is up in the sim ECS task, not just sshd. Poll until it warms.
        `for i in $(seq 1 ${OPENVSCODE_ATTEMPTS}); do`,
        `  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${host}:${String(WORKSPACE_PORT)}/ || echo 000)`,
        `  [ "$code" = "403" ] && { echo "openvscode :${String(WORKSPACE_PORT)} gate => 403" >&2; exit 0; }`,
        "  sleep 2",
        "done",
        'echo "openvscode never returned 403 (last=$code)" >&2',
        "exit 1",
      ].join("\n");
      const out = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family: `golden-ssh-client-${RUN_ID}`,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: "256",
          memory: "512",
          containerDefinitions: [
            {
              name: CLIENT_CONTAINER,
              image: WORKSPACE_IMAGE,
              essential: true,
              entryPoint: ["sh", "-c"],
              command: [script],
              environment: [{ name: "SSH_PRIVATE_KEY_B64", value: privateKeyBase64 }],
              logConfiguration: {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": LOG_GROUP,
                  "awslogs-region": DEFAULT_AWS_REGION,
                  "awslogs-stream-prefix": "golden-client",
                },
              },
            },
          ],
        }),
      );
      return required(out.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");
    }

    async function logMessages(): Promise<string> {
      const out = await logs.send(new FilterLogEventsCommand({ logGroupName: LOG_GROUP }));
      return (out.events ?? []).map((event) => event.message ?? "").join("\n");
    }

    it("launches the managed-EBS golden image, accepts a registered SSH key, and serves OpenVSCode on :3000", async () => {
      // The connecting client's registered key; the stub control plane (reachable
      // from inside the sim task) authorizes it via the golden image's
      // AuthorizedKeysCommand → ssh-authorize.
      const { privateKeyBase64, publicKey } = generateUserKey(USER_KEY, "edd-golden-workspace-e2e");
      const hostAlias = hostReachableTarget(WORKSPACE_IMAGE).host;
      const stub = await startSshAuthorizeStub(publicKey, hostAlias, AGENT_SECRET);
      const { taskArn: workspaceTaskArn, sshHost } = await runWorkspaceTask(stub.controlPlaneUrl);
      try {
        await waitForTask(ecs, workspaceTaskArn, "RUNNING");
        expect(sshHost).toMatch(/^10\.71\.1\.\d+$/);

        const clientTaskDef = await registerClientTask(sshHost, privateKeyBase64);
        const clientRun = await ecs.send(
          new RunTaskCommand({
            cluster: CLUSTER,
            taskDefinition: clientTaskDef,
            launchType: "FARGATE",
            networkConfiguration: {
              awsvpcConfiguration: { subnets: [subnetId], assignPublicIp: "DISABLED" },
            },
          }),
        );
        const clientTask = required(clientRun.tasks?.[0]?.taskArn, "client taskArn");
        const stopped = await waitForTask(ecs, clientTask, "STOPPED", CLIENT_STOP_TIMEOUT_MS);
        expect(taskExitCode(stopped), await logMessages()).toBe(0);
      } finally {
        stub.stop();
        await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: workspaceTaskArn }));
        await waitForTask(ecs, workspaceTaskArn, "STOPPED");
      }
    });

    it("runs a command through an ECS Exec data channel", async () => {
      const taskDef = await ecs.send(
        new RegisterTaskDefinitionCommand({
          family: `exec-smoke-${RUN_ID}`,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: "256",
          memory: "512",
          containerDefinitions: [
            {
              name: "app",
              image: "public.ecr.aws/docker/library/busybox:latest",
              essential: true,
              entryPoint: ["sh", "-c"],
              command: ["sleep 120"],
            },
          ],
        }),
      );
      const taskDefinition = required(
        taskDef.taskDefinition?.taskDefinitionArn,
        "taskDefinitionArn",
      );
      const run = await ecs.send(
        new RunTaskCommand({
          cluster: CLUSTER,
          taskDefinition,
          launchType: "FARGATE",
          enableExecuteCommand: true,
          networkConfiguration: {
            awsvpcConfiguration: { subnets: [subnetId], assignPublicIp: "DISABLED" },
          },
        }),
      );
      const taskArn = required(run.tasks?.[0]?.taskArn, "taskArn");
      try {
        await waitForTask(ecs, taskArn, "RUNNING");
        const out = await ecs.send(
          new ExecuteCommandCommand({
            cluster: CLUSTER,
            task: taskArn,
            container: "app",
            command: `echo ${ECS_EXEC_MARKER}`,
            interactive: true,
          }),
        );

        expect(out.clusterArn).toBeTruthy();
        expect(out.containerArn).toBeTruthy();
        expect(out.containerName).toBe("app");
        expect(out.interactive).toBe(true);
        expect(out.taskArn).toBe(taskArn);
        expect(out.session?.sessionId).toBeTruthy();
        expect(out.session?.streamUrl).toBeTruthy();
        expect(out.session?.tokenValue).toBeTruthy();
        const output = await readExecOutput(
          required(out.session?.streamUrl, "ECS Exec streamUrl"),
          required(out.session?.tokenValue, "ECS Exec tokenValue"),
        );
        expect(output).toContain(ECS_EXEC_MARKER);
      } finally {
        await ecs.send(new StopTaskCommand({ cluster: CLUSTER, task: taskArn }));
        await waitForTask(ecs, taskArn, "STOPPED");
      }
    });
  },
);
