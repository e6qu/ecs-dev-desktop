// SPDX-License-Identifier: AGPL-3.0-or-later
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

/** The managed EBS volume id ECS attached to the task, if present yet. */
function ebsVolumeId(task: Task | undefined): string | undefined {
  for (const a of task?.attachments ?? []) {
    if (a.type !== "AmazonElasticBlockStorage") continue;
    for (const d of a.details ?? []) if (d.name === "volumeId" && d.value) return d.value;
  }
  return undefined;
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
    return { id: taskId(arn), volumeId: volumeId(await this.awaitVolumeId(arn)) };
  }

  /** Poll DescribeTasks until ECS reports the managed EBS volume id. */
  private async awaitVolumeId(taskArn: string): Promise<string> {
    for (let i = 0; i < VOLUME_ATTEMPTS; i++) {
      const out = await this.client.send(
        new DescribeTasksCommand({ cluster: this.cluster(), tasks: [taskArn] }),
      );
      const task = out.tasks?.[0];
      const vol = ebsVolumeId(task);
      if (vol !== undefined) return vol;
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
}
