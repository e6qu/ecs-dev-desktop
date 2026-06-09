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
  DEFAULT_WORKSPACE_VOLUME_GIB,
} from "@edd/config";
import {
  taskId,
  volumeId,
  type BaseImage,
  type ComputeProvider,
  type ComputeTask,
  type RunTaskInput,
  type TaskId,
} from "@edd/core";

interface EnvironmentEntry {
  name: string;
  value: string;
}

/** Task-definition volume name; mounted at the configured path in the container. */
const WORKSPACE_VOLUME = "workspace";
/** Max attempts (×2s) to observe the managed EBS volume id on the new task. */
const VOLUME_ATTEMPTS = 30;

export interface EcsComputeConfig {
  /** ECS cluster the tasks run in. */
  cluster?: string;
  /** awsvpc subnets (required — Fargate runs in a VPC). */
  subnets: string[];
  /** awsvpc security groups. */
  securityGroups?: string[];
  /** IAM role ECS uses to manage the task's EBS volume (the EBS infrastructure role). */
  ebsRoleArn: string;
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
        containerDefinitions: [
          {
            name: this.config.containerName ?? DEFAULT_WORKSPACE_CONTAINER,
            image,
            essential: true,
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
                      "awslogs-region": process.env.AWS_REGION ?? "us-east-1",
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

    const workspaceEnv = workspaceEnvironment(this.config, input.workspaceId);

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
    const task = await this.awaitVolumeId(arn);
    return { id: taskId(arn), volumeId: volumeId(task.volumeId), sshHost: task.sshHost };
  }

  /** Poll DescribeTasks until ECS reports the managed EBS volume id. Also reads the ENI IP. */
  private async awaitVolumeId(taskArn: string): Promise<{ volumeId: string; sshHost?: string }> {
    for (let i = 0; i < VOLUME_ATTEMPTS; i++) {
      const out = await this.client.send(
        new DescribeTasksCommand({ cluster: this.cluster(), tasks: [taskArn] }),
      );
      const task = out.tasks?.[0];
      const vol = ebsVolumeId(task);
      if (vol !== undefined) return { volumeId: vol, sshHost: taskPrivateIp(task) };
      if (task?.lastStatus === "STOPPED") {
        throw new Error(
          `task ${taskArn} stopped before attaching a volume: ${task.stoppedReason ?? "unknown"}`,
        );
      }
      await sleep(2000);
    }
    throw new Error(`timed out awaiting the managed EBS volume for task ${taskArn}`);
  }

  async stopTask(id: TaskId): Promise<void> {
    await this.client.send(new StopTaskCommand({ cluster: this.cluster(), task: id }));
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
   * ECS_SECURITY_GROUPS (comma-separated), ECS_EBS_ROLE_ARN, CONTROL_PLANE_URL,
   * EDD_AGENT_SECRET, EDD_SSH_CA_PUBLIC_KEY. Throws loudly if required vars are absent.
   */
  static fromEnv(agentSecret?: string): EcsComputeProvider {
    const subnets = process.env.ECS_SUBNETS?.split(",").filter(Boolean) ?? [];
    const securityGroups = process.env.ECS_SECURITY_GROUPS?.split(",").filter(Boolean);
    const ebsRoleArn = process.env.ECS_EBS_ROLE_ARN;
    if (subnets.length === 0) throw new Error("COMPUTE_PROVIDER=ecs requires ECS_SUBNETS");
    if (!ebsRoleArn) throw new Error("COMPUTE_PROVIDER=ecs requires ECS_EBS_ROLE_ARN");
    return new EcsComputeProvider({
      client: EcsComputeProvider.client(),
      config: {
        cluster: process.env.ECS_CLUSTER,
        subnets,
        securityGroups,
        ebsRoleArn,
        controlPlaneUrl: process.env.CONTROL_PLANE_URL,
        agentSecret,
        sshCaPublicKey: process.env.EDD_SSH_CA_PUBLIC_KEY,
        logGroupName: process.env.ECS_LOG_GROUP_WORKSPACES,
      },
    });
  }
}
