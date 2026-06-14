// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DescribeTasksCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  DEFAULT_AWS_REGION,
  DEFAULT_ECS_CLUSTER,
  DEFAULT_WORKSPACE_CONTAINER,
  DEFAULT_WORKSPACE_CPU,
  DEFAULT_WORKSPACE_MEMORY,
  DEFAULT_WORKSPACE_MOUNT_PATH,
  DEFAULT_WORKSPACE_PORT,
  DEFAULT_WORKSPACE_VOLUME_GIB,
} from "@edd/config";
import {
  taskId,
  volumeId,
  type BaseImage,
  type ComputeProvider,
  type ComputeTask,
  type TaskLiveness,
  type RunTaskInput,
  type TaskId,
} from "@edd/core";

interface EnvironmentEntry {
  name: string;
  value: string;
}

/** Task-definition volume name; mounted at the configured path in the container. */
const WORKSPACE_VOLUME = "workspace";
/** SSH port the workspace sshd listens on (declared in the task def alongside
 * the OpenVSCode HTTP port {@link DEFAULT_WORKSPACE_PORT}). */
const WORKSPACE_SSH_PORT = 22;
/** Max attempts (×2s) to observe the new task become READY (RUNNING + volume +
 * ENI). 90 × 2s = 180s — covers a real Fargate cold start; the sim is sub-second. */
const READY_ATTEMPTS = 90;

export interface EcsComputeConfig {
  /** ECS cluster the tasks run in. */
  cluster?: string;
  /** awsvpc subnets (required — Fargate runs in a VPC). */
  subnets: string[];
  /** awsvpc security groups. */
  securityGroups?: string[];
  /** IAM role ECS uses to manage the task's EBS volume (the EBS infrastructure role). */
  ebsRoleArn: string;
  /** Task execution role — required on real Fargate to pull a private-ECR image
   * and ship `awslogs`. Optional against the sim (it doesn't enforce IAM). */
  executionRoleArn?: string;
  /** Task role — the IAM identity the workspace container assumes at runtime. */
  taskRoleArn?: string;
  /** Whether the task gets a public IP (to pull images from a public subnet). */
  assignPublicIp?: boolean;
  containerName?: string;
  mountPath?: string;
  volumeSizeGiB?: number;
  cpu?: string;
  memory?: string;
  /** Base URL of the control plane injected into the workspace container. */
  controlPlaneUrl?: string;
  /**
   * 32-byte hex secret used to derive per-workspace HMAC tokens for the
   * idle-agent machine-auth heartbeat path. When present, each launched task
   * receives `EDD_AGENT_TOKEN` = HMAC-SHA256(agentSecret, workspaceId) as an
   * env var; the heartbeat route verifies the same HMAC server-side.
   */
  agentSecret?: string;
  /** OpenSSH CA public key trusted by workspace sshd for user certificates. */
  sshCaPublicKey?: string;
  /** Idle-agent heartbeat interval (seconds) injected into the workspace
   * container as EDD_HEARTBEAT_INTERVAL_S; the image defaults to
   * DEFAULT_HEARTBEAT_INTERVAL_S when absent (scale-to-zero tuning knob). */
  heartbeatIntervalS?: number;
  /** CloudWatch Logs group for workspace container stdout/stderr (awslogs driver).
   * When set, every task definition includes logConfiguration pointing here.
   * Matches the log group created by the Terraform module (e.g. "/${appName}/workspaces"). */
  logGroupName?: string;
}

export interface EcsComputeProviderDeps {
  client: ECSClient;
  config: EcsComputeConfig;
}

function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) throw new Error(`ECS response missing ${field}`);
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse an env var as a positive integer, or undefined if unset/empty. Throws
 * loudly on a non-positive/non-numeric value rather than silently defaulting. */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number: ${raw}`);
  return n;
}

/** A valid ECS task-definition family derived from a base-image reference
 * (ECS families allow letters, numbers, hyphens, underscores). */
export function taskDefinitionFamily(image: BaseImage): string {
  return `edd-ws-${image.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 200)}`;
}

/** Derive the per-workspace idle-agent token: HMAC-SHA256(secret, workspaceId). */
export function agentToken(secret: string, wsId: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(wsId).digest("hex");
}

/** Constant-time equality for HMAC verification (prevents timing attacks). */
export function verifyAgentToken(secret: string, wsId: string, candidate: string): boolean {
  const expected = agentToken(secret, wsId);
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

export function workspaceEnvironment(
  config: EcsComputeConfig,
  workspaceId: string,
  repo?: { url?: string; ref?: string },
): EnvironmentEntry[] {
  const env: EnvironmentEntry[] = [{ name: "EDD_WORKSPACE_ID", value: workspaceId }];
  if (config.controlPlaneUrl !== undefined)
    env.push({ name: "EDD_CONTROL_PLANE_URL", value: config.controlPlaneUrl });
  if (config.agentSecret !== undefined)
    env.push({
      name: "EDD_AGENT_TOKEN",
      value: agentToken(config.agentSecret, workspaceId),
    });
  if (config.sshCaPublicKey !== undefined)
    env.push({ name: "EDD_SSH_CA_PUBLIC_KEY", value: config.sshCaPublicKey });
  if (config.heartbeatIntervalS !== undefined)
    env.push({ name: "EDD_HEARTBEAT_INTERVAL_S", value: String(config.heartbeatIntervalS) });
  // Repo to clone at first boot ("one repo per session"). The git credential is
  // fetched by the in-workspace agent over its authenticated channel, never
  // injected here.
  if (repo?.url !== undefined && repo.url.length > 0)
    env.push({ name: "EDD_REPO_URL", value: repo.url });
  if (repo?.ref !== undefined && repo.ref.length > 0)
    env.push({ name: "EDD_REPO_REF", value: repo.ref });
  return env;
}

/** The managed EBS volume id ECS attached to the task, if present yet. */
function ebsVolumeId(task: Task | undefined): string | undefined {
  for (const a of task?.attachments ?? []) {
    if (a.type !== "AmazonElasticBlockStorage") continue;
    for (const d of a.details ?? []) if (d.name === "volumeId" && d.value) return d.value;
  }
  return undefined;
}

/** The task's ENI private IP — set at RunTask time, present before RUNNING. */
export function taskPrivateIp(task: Task | undefined): string | undefined {
  // Prefer the attachment details (matches real Fargate DescribeTasks shape).
  for (const a of task?.attachments ?? []) {
    if (a.type !== "ElasticNetworkInterface") continue;
    for (const d of a.details ?? []) {
      if (d.name === "privateIPv4Address" && d.value) return d.value;
    }
  }
  // Fall back to the per-container networkInterfaces array.
  const ip = task?.containers?.[0]?.networkInterfaces?.[0]?.privateIpv4Address;
  return ip ?? undefined;
}

/**
 * Whether a task is ready to serve, and its serving coordinates if so. A task is
 * ready once ECS reports it RUNNING with its managed EBS volume attached AND its
 * ENI private IP assigned — i.e. the container is actually up and routable, not
 * merely PROVISIONING/PENDING. `runTask` gates on this so the control plane never
 * reports a workspace `running` (or hands out `sshHost`/connect-info) before it
 * can accept connections — the readiness gap every caller used to paper over with
 * its own retry loop. Returns undefined until all three hold.
 */
export function taskReady(
  task: Task | undefined,
): { volumeId: string; sshHost: string } | undefined {
  if (task?.lastStatus !== "RUNNING") return undefined;
  const vol = ebsVolumeId(task);
  const sshHost = taskPrivateIp(task);
  if (vol === undefined || sshHost === undefined) return undefined;
  return { volumeId: vol, sshHost };
}

/**
 * Real Fargate ComputeProvider. `runTask` registers a task definition for the
 * base image (cached), launches it with an ECS-**managed** EBS volume (created
 * fresh, or hydrated from a snapshot on wake), and returns the task + the volume
 * id ECS created; `stopTask` stops the task (ECS releases the managed volume).
 * Endpoint-only — identical against the sockerless sim and real AWS (§6.8).
 */
export class EcsComputeProvider implements ComputeProvider {
  private readonly registered = new Map<string, string>();
  private readonly client: ECSClient;
  private readonly config: EcsComputeConfig;

  constructor(deps: EcsComputeProviderDeps) {
    this.client = deps.client;
    this.config = deps.config;
  }

  private cluster(): string {
    return this.config.cluster ?? DEFAULT_ECS_CLUSTER;
  }

  private async ensureTaskDef(image: BaseImage): Promise<string> {
    const cached = this.registered.get(image);
    if (cached !== undefined) return cached;
    const out = await this.client.send(
      new RegisterTaskDefinitionCommand({
        family: taskDefinitionFamily(image),
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        cpu: this.config.cpu ?? DEFAULT_WORKSPACE_CPU,
        memory: this.config.memory ?? DEFAULT_WORKSPACE_MEMORY,
        // On real Fargate the execution role is required to pull a private-ECR
        // image and ship awslogs; the task role is the container's runtime
        // identity. Both optional against the sim (no IAM enforcement).
        ...(this.config.executionRoleArn !== undefined
          ? { executionRoleArn: this.config.executionRoleArn }
          : {}),
        ...(this.config.taskRoleArn !== undefined ? { taskRoleArn: this.config.taskRoleArn } : {}),
        containerDefinitions: [
          {
            name: this.config.containerName ?? DEFAULT_WORKSPACE_CONTAINER,
            image,
            essential: true,
            // Declare the OpenVSCode HTTP port and sshd port (awsvpc shares the
            // task ENI, so this documents the contract the proxy/gateway use).
            portMappings: [
              { containerPort: DEFAULT_WORKSPACE_PORT, protocol: "tcp" },
              { containerPort: WORKSPACE_SSH_PORT, protocol: "tcp" },
            ],
            mountPoints: [
              {
                sourceVolume: WORKSPACE_VOLUME,
                containerPath: this.config.mountPath ?? DEFAULT_WORKSPACE_MOUNT_PATH,
              },
            ],
            ...(this.config.logGroupName !== undefined
              ? {
                  logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                      "awslogs-group": this.config.logGroupName,
                      "awslogs-region": process.env.AWS_REGION ?? DEFAULT_AWS_REGION,
                      "awslogs-stream-prefix": "workspace",
                    },
                  },
                }
              : {}),
          },
        ],
        volumes: [{ name: WORKSPACE_VOLUME, configuredAtLaunch: true }],
      }),
    );
    const arn = required(out.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");
    this.registered.set(image, arn);
    return arn;
  }

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const taskDef = await this.ensureTaskDef(input.baseImage);

    const workspaceEnv = workspaceEnvironment(this.config, input.workspaceId, {
      url: input.repoUrl,
      ref: input.repoRef,
    });

    const out = await this.client.send(
      new RunTaskCommand({
        cluster: this.cluster(),
        taskDefinition: taskDef,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnets,
            ...(this.config.securityGroups ? { securityGroups: this.config.securityGroups } : {}),
            assignPublicIp: (this.config.assignPublicIp ?? true) ? "ENABLED" : "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.config.containerName ?? DEFAULT_WORKSPACE_CONTAINER,
              environment: workspaceEnv,
            },
          ],
        },
        volumeConfigurations: [
          {
            name: WORKSPACE_VOLUME,
            managedEBSVolume: {
              roleArn: this.config.ebsRoleArn,
              ...(input.fromSnapshot === undefined
                ? { sizeInGiB: this.config.volumeSizeGiB ?? DEFAULT_WORKSPACE_VOLUME_GIB }
                : { snapshotId: input.fromSnapshot }),
              terminationPolicy: { deleteOnTermination: true },
            },
          },
        ],
      }),
    );
    const arn = required(out.tasks?.[0]?.taskArn, "taskArn");
    const ready = await this.awaitTaskReady(arn);
    return { id: taskId(arn), volumeId: volumeId(ready.volumeId), sshHost: ready.sshHost };
  }

  /**
   * Poll DescribeTasks until the task is READY — RUNNING with its managed EBS
   * volume attached and its ENI private IP assigned (see `taskReady`) — so the
   * caller doesn't get a `running` task that can't yet accept connections. Throws
   * if the task stops first, or on timeout.
   */
  private async awaitTaskReady(taskArn: string): Promise<{ volumeId: string; sshHost: string }> {
    for (let i = 0; i < READY_ATTEMPTS; i++) {
      const out = await this.client.send(
        new DescribeTasksCommand({ cluster: this.cluster(), tasks: [taskArn] }),
      );
      const task = out.tasks?.[0];
      const ready = taskReady(task);
      if (ready !== undefined) return ready;
      if (task?.lastStatus === "STOPPED") {
        throw new Error(
          `task ${taskArn} stopped before becoming ready: ${task.stoppedReason ?? "unknown"}`,
        );
      }
      await sleep(2000);
    }
    throw new Error(`timed out awaiting task ${taskArn} to become ready (RUNNING + volume + ENI)`);
  }

  async stopTask(id: TaskId): Promise<void> {
    await this.client.send(
      new StopTaskCommand({
        cluster: this.cluster(),
        task: id,
        reason: "edd: workspace lifecycle stop (scale-to-zero/delete)",
      }),
    );
  }

  /** Observed liveness via DescribeTasks. A missing/expired task (ECS prunes
   * stopped tasks after a retention window) and every wind-down status count
   * as stopped; PENDING/PROVISIONING count as running so an in-flight wake is
   * never flagged as drift. */
  async taskState(id: TaskId): Promise<TaskLiveness> {
    const out = await this.client.send(
      new DescribeTasksCommand({ cluster: this.cluster(), tasks: [id] }),
    );
    const status = out.tasks?.[0]?.lastStatus;
    if (status === undefined) return "stopped";
    return ["DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED", "DELETED"].includes(status)
      ? "stopped"
      : "running";
  }

  /** Build an ECS client from the ambient AWS env (`AWS_ENDPOINT_URL` → the sim). */
  static client(): ECSClient {
    const endpoint = process.env.AWS_ENDPOINT_URL;
    return new ECSClient({
      region: process.env.AWS_REGION ?? DEFAULT_AWS_REGION,
      ...(endpoint
        ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    });
  }

  /**
   * Build a provider from the ambient AWS env and control-plane env vars.
   * Reads: AWS_REGION, AWS_ENDPOINT_URL, ECS_CLUSTER, ECS_SUBNETS (comma-separated),
   * ECS_SECURITY_GROUPS (comma-separated), ECS_EBS_ROLE_ARN, ECS_EXECUTION_ROLE_ARN,
   * ECS_TASK_ROLE_ARN, ECS_TASK_CPU, ECS_TASK_MEMORY, ECS_VOLUME_GIB, CONTROL_PLANE_URL,
   * EDD_AGENT_SECRET, EDD_SSH_CA_PUBLIC_KEY. Throws loudly if required vars are absent.
   */
  static fromEnv(agentSecret?: string): EcsComputeProvider {
    const subnets = process.env.ECS_SUBNETS?.split(",").filter(Boolean) ?? [];
    const securityGroups = process.env.ECS_SECURITY_GROUPS?.split(",").filter(Boolean);
    const ebsRoleArn = process.env.ECS_EBS_ROLE_ARN;
    if (subnets.length === 0) throw new Error("COMPUTE_PROVIDER=ecs requires ECS_SUBNETS");
    if (!ebsRoleArn) throw new Error("COMPUTE_PROVIDER=ecs requires ECS_EBS_ROLE_ARN");
    const heartbeatIntervalS = positiveIntEnv("EDD_HEARTBEAT_INTERVAL_S");
    const volumeSizeGiB = positiveIntEnv("ECS_VOLUME_GIB");
    return new EcsComputeProvider({
      client: EcsComputeProvider.client(),
      config: {
        cluster: process.env.ECS_CLUSTER,
        subnets,
        securityGroups,
        ebsRoleArn,
        executionRoleArn: process.env.ECS_EXECUTION_ROLE_ARN,
        taskRoleArn: process.env.ECS_TASK_ROLE_ARN,
        // Task sizing — optional overrides of the @edd/config defaults.
        ...(process.env.ECS_TASK_CPU !== undefined ? { cpu: process.env.ECS_TASK_CPU } : {}),
        ...(process.env.ECS_TASK_MEMORY !== undefined
          ? { memory: process.env.ECS_TASK_MEMORY }
          : {}),
        ...(volumeSizeGiB !== undefined ? { volumeSizeGiB } : {}),
        // Public-subnet egress (image pulls; sim route-table model needs it too).
        assignPublicIp: process.env.ECS_ASSIGN_PUBLIC_IP === "1",
        controlPlaneUrl: process.env.CONTROL_PLANE_URL,
        agentSecret,
        sshCaPublicKey: process.env.EDD_SSH_CA_PUBLIC_KEY,
        logGroupName: process.env.ECS_LOG_GROUP_WORKSPACES,
        ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
      },
    });
  }
}
