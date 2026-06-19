// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DescribeClustersCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  paginateListSecrets,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  AWS_SDK_MAX_ATTEMPTS,
  AWS_SDK_RETRY_MODE,
  DEFAULT_AWS_REGION,
  DEFAULT_ECS_CLUSTER,
  DEFAULT_WORKSPACE_LOG_STREAM_PREFIX,
  DEFAULT_WORKSPACE_CONTAINER,
  DEFAULT_WORKSPACE_CPU,
  DEFAULT_WORKSPACE_MEMORY,
  DEFAULT_WORKSPACE_MOUNT_PATH,
  DEFAULT_WORKSPACE_PORT,
  DEFAULT_WORKSPACE_VOLUME_GIB,
} from "@edd/config";
import {
  isoTimestamp,
  taskId,
  volumeId,
  workspaceId,
  type BaseImage,
  type ClusterInfo,
  type ComponentHealth,
  type ComputeProvider,
  type ComputeTask,
  type TaskLiveness,
  type RunTaskInput,
  type TaskId,
  type WorkspaceAgentSecretRef,
  type WorkspaceTaskRef,
} from "@edd/core";

interface EnvironmentEntry {
  name: string;
  value: string;
}

/** Task-definition volume name; mounted at the configured path in the container. */
const WORKSPACE_VOLUME = "workspace";
/** ECS task tag carrying the owning workspace id, set on every workspace task at
 * launch. The reconciler's orphan-task reaper enumerates tasks by this tag (so it
 * only ever reaps workspace tasks, never the control-plane/reconciler tasks that
 * share the cluster) and reads the workspace id from its value. */
const WORKSPACE_TAG_KEY = "edd:workspace-id";
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
  /** Secrets Manager client. When present (and `config.agentSecret` is set), the
   * per-workspace agent token is injected via ECS `secrets` (Secrets Manager)
   * instead of plaintext `environment`, so it never appears in DescribeTasks /
   * console / CloudTrail. Absent → the legacy plaintext-env path (local/fakes). */
  secretsClient?: SecretsManagerClient;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  opts?: { omitAgentToken?: boolean },
): EnvironmentEntry[] {
  const env: EnvironmentEntry[] = [{ name: "EDD_WORKSPACE_ID", value: workspaceId }];
  if (config.controlPlaneUrl !== undefined)
    env.push({ name: "EDD_CONTROL_PLANE_URL", value: config.controlPlaneUrl });
  // The agent token is omitted here when it is delivered via ECS `secrets`
  // (Secrets Manager) instead — see EcsComputeProvider.runTask.
  if (config.agentSecret !== undefined && opts?.omitAgentToken !== true)
    env.push({
      name: "EDD_AGENT_TOKEN",
      value: agentToken(config.agentSecret, workspaceId),
    });
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
  private readonly secrets?: SecretsManagerClient;

  constructor(deps: EcsComputeProviderDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.secrets = deps.secretsClient;
  }

  /** Whether the per-workspace agent token is delivered via Secrets Manager
   * (rather than plaintext env): a secrets client + an agent secret are present. */
  private get usesSecretInjection(): boolean {
    return this.secrets !== undefined && this.config.agentSecret !== undefined;
  }

  private cluster(): string {
    return this.config.cluster ?? DEFAULT_ECS_CLUSTER;
  }

  private async ensureTaskDef(
    image: BaseImage,
    agentSecret?: { arn: string; wsId: string },
  ): Promise<string> {
    // A secret ARN is per-workspace, so the task def referencing it must be too;
    // cache by (image, workspace). The plaintext-env path stays cached per image.
    const cacheKey = agentSecret !== undefined ? `${image}::${agentSecret.wsId}` : image;
    const cached = this.registered.get(cacheKey);
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
            // Deliver the agent token via ECS `secrets` (Secrets Manager) — ECS
            // resolves it into the container env at launch, never exposing it in
            // DescribeTasks/CloudTrail the way plaintext `environment` would.
            ...(agentSecret !== undefined
              ? { secrets: [{ name: "EDD_AGENT_TOKEN", valueFrom: agentSecret.arn }] }
              : {}),
            ...(this.config.logGroupName !== undefined
              ? {
                  logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                      "awslogs-group": this.config.logGroupName,
                      "awslogs-region": process.env.AWS_REGION ?? DEFAULT_AWS_REGION,
                      "awslogs-stream-prefix": DEFAULT_WORKSPACE_LOG_STREAM_PREFIX,
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
    this.registered.set(cacheKey, arn);
    return arn;
  }

  /**
   * Ensure a per-workspace Secrets Manager secret holds the agent token, and
   * return its ARN. The token is deterministic (HMAC(agentSecret, wsId)) so the
   * value is stable across wakes; create it once, update idempotently otherwise.
   */
  private async ensureAgentSecret(client: SecretsManagerClient, wsId: string): Promise<string> {
    const token = agentToken(required(this.config.agentSecret, "agentSecret"), wsId);
    const name = `edd/workspace/${wsId}/agent`;
    try {
      const out = await client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: token,
          // Tagged so the reconciler's orphan-secret GC can find + attribute it,
          // and the reaper's tag-scoped IAM applies (edd:managed, like every resource).
          Tags: [
            { Key: WORKSPACE_TAG_KEY, Value: wsId },
            { Key: "edd:managed", Value: "true" },
          ],
        }),
      );
      return required(out.ARN, "secret ARN");
    } catch (err) {
      if (err instanceof Error && err.name === "ResourceExistsException") {
        const put = await client.send(
          new PutSecretValueCommand({ SecretId: name, SecretString: token }),
        );
        return required(put.ARN, "secret ARN");
      }
      throw err;
    }
  }

  /** Enumerate the per-workspace agent-token secrets (by name prefix), for the
   * reconciler's orphan-secret GC. No-op shape when no secrets client is configured. */
  async listWorkspaceAgentSecrets(): Promise<readonly WorkspaceAgentSecretRef[]> {
    if (this.secrets === undefined) return [];
    const refs: WorkspaceAgentSecretRef[] = [];
    for await (const page of paginateListSecrets(
      { client: this.secrets },
      { Filters: [{ Key: "tag-key", Values: [WORKSPACE_TAG_KEY] }] },
    )) {
      for (const s of page.SecretList ?? []) {
        const wsId = (s.Tags ?? []).find((t) => t.Key === WORKSPACE_TAG_KEY)?.Value;
        if (s.Name === undefined || wsId === undefined || s.CreatedDate === undefined) continue;
        refs.push({
          name: s.Name,
          workspaceId: workspaceId(wsId),
          createdAt: isoTimestamp(s.CreatedDate.toISOString()),
        });
      }
    }
    return refs;
  }

  /** Delete an agent secret by name (idempotent: a missing secret is a no-op).
   * `ForceDeleteWithoutRecovery` skips the 30-day recovery window so the name + token
   * are reclaimed immediately. */
  async deleteAgentSecret(name: string): Promise<void> {
    if (this.secrets === undefined) return;
    try {
      await this.secrets.send(
        new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "ResourceNotFoundException") return;
      throw err;
    }
  }

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    // Secure path: stash the agent token in Secrets Manager and reference it from
    // a per-workspace task def, so it is never injected as plaintext env.
    let agentSecret: { arn: string; wsId: string } | undefined;
    if (this.usesSecretInjection && this.secrets !== undefined) {
      agentSecret = {
        arn: await this.ensureAgentSecret(this.secrets, input.workspaceId),
        wsId: input.workspaceId,
      };
    }
    const taskDef = await this.ensureTaskDef(input.baseImage, agentSecret);

    const workspaceEnv = workspaceEnvironment(
      this.config,
      input.workspaceId,
      { url: input.repoUrl, ref: input.repoRef },
      { omitAgentToken: agentSecret !== undefined },
    );

    const out = await this.client.send(
      new RunTaskCommand({
        cluster: this.cluster(),
        taskDefinition: taskDef,
        launchType: "FARGATE",
        // Tag the task with its workspace so the reconciler's orphan-task reaper can
        // enumerate workspace tasks (and only those) and read the workspace id back.
        tags: [{ key: WORKSPACE_TAG_KEY, value: input.workspaceId }],
        // Inject the SSM exec agent so admins/automation can `aws ecs execute-command`
        // into a live workspace (debugging, break-glass) — the capability was
        // sim-proven on a standalone task; the production launch path enables it too.
        enableExecuteCommand: true,
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
    // The task is now launched. If it never becomes ready (stops mid-boot, or the
    // readiness poll times out), stop it before propagating — otherwise a failed
    // launch leaks a running Fargate task and its managed EBS volume (the caller
    // never receives this ARN, so it cannot compensate; the managed volume's
    // deleteOnTermination then reaps the volume with the stopped task).
    try {
      const ready = await this.awaitTaskReady(arn);
      return { id: taskId(arn), volumeId: volumeId(ready.volumeId), sshHost: ready.sshHost };
    } catch (err) {
      try {
        await this.stopTask(taskId(arn));
      } catch (stopErr) {
        // Cleanup failed too — do not swallow it: the task may be leaked and needs a
        // look. Surface it alongside the original launch failure.
        throw new Error(
          `workspace task ${arn} failed to become ready and could not be stopped ` +
            `(it may be leaked — needs manual cleanup): ${errMessage(err)}; ` +
            `stop error: ${errMessage(stopErr)}`,
          { cause: stopErr },
        );
      }
      throw err;
    }
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

  /**
   * Enumerate RUNNING workspace tasks (those carrying the {@link WORKSPACE_TAG_KEY}
   * tag) for the reconciler's orphan-task reaper. ListTasks gives RUNNING task ARNs
   * (paginated); DescribeTasks (with TAGS) resolves each task's owning-workspace tag
   * and start time. Non-workspace tasks in the same cluster (control-plane,
   * reconciler) lack the tag and are excluded.
   */
  async listWorkspaceTasks(): Promise<readonly WorkspaceTaskRef[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListTasksCommand({
          cluster: this.cluster(),
          desiredStatus: "RUNNING",
          ...(nextToken === undefined ? {} : { nextToken }),
        }),
      );
      arns.push(...(page.taskArns ?? []));
      nextToken = page.nextToken;
    } while (nextToken !== undefined);

    const refs: WorkspaceTaskRef[] = [];
    // DescribeTasks accepts at most 100 task ARNs per call.
    for (let i = 0; i < arns.length; i += 100) {
      const batch = arns.slice(i, i + 100);
      const out = await this.client.send(
        new DescribeTasksCommand({ cluster: this.cluster(), tasks: batch, include: ["TAGS"] }),
      );
      for (const task of out.tasks ?? []) {
        const wsId = task.tags?.find((t) => t.key === WORKSPACE_TAG_KEY)?.value;
        // A workspace task always has the tag, an ARN, and (once launched) a start
        // time; skip anything missing one rather than guess.
        if (wsId === undefined || task.taskArn === undefined || task.startedAt === undefined) {
          continue;
        }
        refs.push({
          id: taskId(task.taskArn),
          workspaceId: workspaceId(wsId),
          startedAt: isoTimestamp(task.startedAt.toISOString()),
        });
      }
    }
    return refs;
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

  /**
   * Live compute-plane health for the admin Health board: DescribeClusters on the
   * configured ECS cluster. ACTIVE → ok; any other status → degraded; an API error
   * (unreachable/denied) → down. The fake reported `ok` while the real adapter
   * reported nothing (the port made `health` optional), so the board showed compute
   * `unknown` even on AWS — this closes that inverted contract.
   */
  async health(): Promise<ComponentHealth> {
    const name = this.cluster();
    try {
      const out = await this.client.send(new DescribeClustersCommand({ clusters: [name] }));
      const status = out.clusters?.[0]?.status;
      if (status === "ACTIVE") {
        return { component: "compute", status: "ok", detail: `ECS cluster ${name} ACTIVE` };
      }
      return {
        component: "compute",
        status: "degraded",
        detail: `ECS cluster ${name} status ${status ?? "not found"}`,
      };
    } catch (err) {
      return {
        component: "compute",
        status: "down",
        detail: `ECS DescribeClusters failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Live cluster state for the admin Infrastructure view (ECS DescribeClusters).
   * Returns the cluster's task/service/instance counts. A not-found cluster still
   * returns a row (status reflects what ECS reports) rather than throwing, so the
   * UI can show "the cluster is missing" instead of an error. Endpoint-only: the
   * same call hits the sim or real ECS by coordinates alone.
   */
  async clusterInfo(): Promise<ClusterInfo> {
    const name = this.cluster();
    const out = await this.client.send(new DescribeClustersCommand({ clusters: [name] }));
    const cluster = out.clusters?.[0];
    return {
      name,
      status: cluster?.status ?? "not found",
      runningTasks: cluster?.runningTasksCount ?? 0,
      pendingTasks: cluster?.pendingTasksCount ?? 0,
      activeServices: cluster?.activeServicesCount ?? 0,
      registeredContainerInstances: cluster?.registeredContainerInstancesCount ?? 0,
    };
  }

  /** Build an ECS client from the ambient AWS env (`AWS_ENDPOINT_URL` → the sim). */
  static client(): ECSClient {
    const endpoint = process.env.AWS_ENDPOINT_URL;
    return new ECSClient({
      region: process.env.AWS_REGION ?? DEFAULT_AWS_REGION,
      maxAttempts: AWS_SDK_MAX_ATTEMPTS,
      retryMode: AWS_SDK_RETRY_MODE,
      ...(endpoint
        ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    });
  }

  /** Build a Secrets Manager client from the ambient AWS env (endpoint → the sim). */
  static secretsClient(): SecretsManagerClient {
    const endpoint = process.env.AWS_ENDPOINT_URL;
    return new SecretsManagerClient({
      region: process.env.AWS_REGION ?? DEFAULT_AWS_REGION,
      maxAttempts: AWS_SDK_MAX_ATTEMPTS,
      retryMode: AWS_SDK_RETRY_MODE,
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
   * EDD_AGENT_SECRET. Throws loudly if required vars are absent.
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
      // The agent token goes into Secrets Manager (not plaintext env) whenever an
      // agent secret is configured — the production/e2e path always does.
      ...(agentSecret !== undefined ? { secretsClient: EcsComputeProvider.secretsClient() } : {}),
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
        logGroupName: process.env.ECS_LOG_GROUP_WORKSPACES,
        ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
      },
    });
  }
}
