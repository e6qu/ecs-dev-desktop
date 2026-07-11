// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DeregisterTaskDefinitionCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  paginateListTaskDefinitionFamilies,
  paginateListTaskDefinitions,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  UpdateServiceCommand,
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
  COST_SCOPE,
  COST_SCOPE_TAG_KEY,
  DEFAULT_AWS_REGION,
  DEFAULT_ECS_CLUSTER,
  DEFAULT_WORKSPACE_LOG_STREAM_PREFIX,
  DEFAULT_WORKSPACE_CONTAINER,
  DEFAULT_WORKSPACE_MOUNT_PATH,
  DEFAULT_WORKSPACE_PORT,
} from "@edd/config";
import {
  DEFAULT_HEARTBEAT_INTERVAL_S,
  METRIC_WORKSPACE_STARTUP_PHASE_FAILED,
  METRIC_WORKSPACE_STARTUP_PHASE_MS,
  deriveWorkspaceToken,
  isoTimestamp,
  taskId,
  verifyWorkspaceToken,
  volumeId,
  workspaceId,
  type BaseImage,
  type ClusterInfo,
  type ComponentHealth,
  type ComputeProvider,
  type ComputeTask,
  type EditorKind,
  type MetricDimensions,
  type MetricSink,
  type TaskLiveness,
  type RunTaskInput,
  type TaskId,
  type WorkspaceAgentSecretRef,
  type WorkspaceResources,
  type WorkspaceTaskRef,
} from "@edd/core";

interface EnvironmentEntry {
  name: string;
  value: string;
}

/** Task-definition volume name; mounted at the configured path in the container. */
const WORKSPACE_VOLUME = "workspace";

/** ECS error names that mean a `StopTask` target task is already gone — already
 * in the desired stopped state, so the stop is a no-op success (idempotent).
 * Anything else is a real error and is rethrown. */
const STOP_TASK_ALREADY_GONE: ReadonlySet<string> = new Set([
  "ResourceNotFoundException",
  "InvalidParameterException",
]);
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
  /** Base URL of the control plane injected into the workspace container. */
  controlPlaneUrl?: string;
  /**
   * 32-byte hex secret used to derive per-workspace HMAC tokens for the
   * idle-agent machine-auth heartbeat path. When present, each launched task
   * receives `EDD_AGENT_TOKEN` = HMAC-SHA256(agentSecret, workspaceId) as an
   * env var; the heartbeat route verifies the same HMAC server-side.
   */
  agentSecret?: string;
  /**
   * 32-byte hex secret used to derive each workspace's OpenVSCode **connection
   * token** = HMAC-SHA256(connectionSecret, workspaceId). When present, the task
   * receives it as `CONNECTION_TOKEN` (so the editor requires `?tkn=`), and the
   * in-app proxy derives the same value to hand the authenticated browser the token
   * — defence-in-depth behind the session-authorizing proxy. Golden workspace
   * images fail loudly when neither `CONNECTION_TOKEN` nor an explicit tokenless
   * launch mode is supplied.
   */
  connectionSecret?: string;
  /** Idle-agent heartbeat interval (seconds) injected into the workspace
   * container as EDD_HEARTBEAT_INTERVAL_S. Defaults to
   * {@link DEFAULT_HEARTBEAT_INTERVAL_S} (scale-to-zero tuning knob). */
  heartbeatIntervalS?: number;
  /** CloudWatch Logs group for workspace container stdout/stderr (awslogs driver).
   * When set, every task definition includes logConfiguration pointing here.
   * Matches the log group created by the Terraform module (e.g. "/${appName}/workspaces"). */
  logGroupName?: string;
  /** Value for the shared AWS cost-allocation tag key (`edd:cost-scope`). */
  costScope?: string;
}

export interface EcsComputeProviderDeps {
  client: ECSClient;
  config: EcsComputeConfig;
  /** Optional metric sink for startup sub-phases owned by the ECS adapter. */
  metrics?: MetricSink;
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

/**
 * Whether a RunTask error means the referenced task definition is no longer usable —
 * an INACTIVE (deregistered/pruned) revision, or one that can't be found. AWS raises
 * these as `ClientException`/`InvalidParameterException` with a message naming the task
 * definition; matching the message keeps us resilient to the exact exception class.
 * Used to evict the stale in-process ARN cache and re-register rather than fail the wake.
 */
function isInactiveTaskDefError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  if (!msg.includes("task definition")) return false;
  return (
    msg.includes("inactive") ||
    msg.includes("does not exist") ||
    msg.includes("not found") ||
    msg.includes("unable to describe")
  );
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

/** Prefix of every workspace task-definition family — distinguishes them from the
 * control-plane/reconciler task defs so the reconciler's task-def GC only prunes ours. */
const WORKSPACE_TASKDEF_FAMILY_PREFIX = "edd-ws-";

function costScopeTags(config: EcsComputeConfig): { key: string; value: string }[] {
  return [{ key: COST_SCOPE_TAG_KEY, value: config.costScope ?? COST_SCOPE }];
}

function costScopeSecretTags(config: EcsComputeConfig): { Key: string; Value: string }[] {
  return [{ Key: COST_SCOPE_TAG_KEY, Value: config.costScope ?? COST_SCOPE }];
}

function startupDimensions(input: RunTaskInput): MetricDimensions {
  return {
    operation: input.fromSnapshot === undefined ? "create" : "wake",
    launch: input.fromSnapshot === undefined ? "fresh" : "snapshot",
    editor: input.editor ?? "openvscode",
    cpuUnits: input.resources.cpuUnits.toString(),
    memoryMiB: input.resources.memoryMiB.toString(),
    volumeGiB: input.resources.volumeGiB.toString(),
  };
}

/** A valid ECS task-definition family derived from a base-image reference
 * (ECS families allow letters, numbers, hyphens, underscores). Fails loudly on an
 * empty image rather than emitting a bare `edd-ws-` family — an empty ref would
 * otherwise collide every empty/garbage image onto one degenerate family (§6.5);
 * `provisionBaseImage` already rejects empty image refs at the source. */
export function taskDefinitionFamily(image: BaseImage): string {
  const slug = image.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 200);
  if (slug === "") {
    throw new Error("taskDefinitionFamily: image yields an empty family slug (empty image ref)");
  }
  return `${WORKSPACE_TASKDEF_FAMILY_PREFIX}${slug}`;
}

/** Derive the per-workspace idle-agent token (the shared per-workspace HMAC). */
export function agentToken(secret: string, wsId: string): string {
  return deriveWorkspaceToken(secret, wsId);
}

/** Constant-time equality for HMAC verification (prevents timing attacks). */
export function verifyAgentToken(secret: string, wsId: string, candidate: string): boolean {
  return verifyWorkspaceToken(secret, wsId, candidate);
}

export function workspaceEnvironment(
  config: EcsComputeConfig,
  workspaceId: string,
  repo?: { url?: string; ref?: string },
  opts?: { omitAgentToken?: boolean; omitConnectionToken?: boolean },
  editor?: EditorKind,
): EnvironmentEntry[] {
  const env: EnvironmentEntry[] = [{ name: "EDD_WORKSPACE_ID", value: workspaceId }];
  // Which editor the entrypoint launches. Only emitted when chosen; the container defaults to
  // OpenVSCode when unset, so existing tasks are unaffected.
  if (editor !== undefined) env.push({ name: "EDD_EDITOR_MODE", value: editor });
  if (config.controlPlaneUrl !== undefined)
    env.push({ name: "EDD_CONTROL_PLANE_URL", value: config.controlPlaneUrl });
  // The agent token is omitted here when it is delivered via ECS `secrets`
  // (Secrets Manager) instead — see EcsComputeProvider.runTask.
  if (config.agentSecret !== undefined && opts?.omitAgentToken !== true)
    env.push({
      name: "EDD_AGENT_TOKEN",
      value: agentToken(config.agentSecret, workspaceId),
    });
  // The editor connection token — same Secrets-Manager-vs-plaintext split as the
  // agent token. When set, the editor requires `?tkn=`; the in-app proxy derives the
  // same value to hand the authenticated browser the token.
  if (config.connectionSecret !== undefined && opts?.omitConnectionToken !== true)
    env.push({
      name: "CONNECTION_TOKEN",
      value: deriveWorkspaceToken(config.connectionSecret, workspaceId),
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
  private readonly metrics?: MetricSink;

  constructor(deps: EcsComputeProviderDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.secrets = deps.secretsClient;
    this.metrics = deps.metrics;
  }

  private cluster(): string {
    return this.config.cluster ?? DEFAULT_ECS_CLUSTER;
  }

  private taskDefCacheKey(input: {
    image: BaseImage;
    resources: WorkspaceResources;
    injected?: { wsId: string; entries: { name: string; valueFrom: string }[] };
  }): string {
    // A secret ARN is per-workspace, so the task def referencing it must be too;
    // cache by (image, workspace, resources). The plaintext-env path stays cached
    // per image/resources pair.
    const resourceKey = `${input.resources.cpuUnits.toString()}-${input.resources.memoryMiB.toString()}`;
    return input.injected !== undefined
      ? `${input.image}::${resourceKey}::${input.injected.wsId}`
      : `${input.image}::${resourceKey}`;
  }

  private async ensureTaskDef(input: {
    image: BaseImage;
    resources: WorkspaceResources;
    injected?: { wsId: string; entries: { name: string; valueFrom: string }[] };
  }): Promise<string> {
    const cacheKey = this.taskDefCacheKey(input);
    const cached = this.registered.get(cacheKey);
    if (cached !== undefined) return cached;
    const out = await this.client.send(
      new RegisterTaskDefinitionCommand({
        family: taskDefinitionFamily(input.image),
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        cpu: String(input.resources.cpuUnits),
        memory: String(input.resources.memoryMiB),
        // On real Fargate the execution role is required to pull a private-ECR
        // image and ship awslogs; the task role is the container's runtime
        // identity. Both optional config — omitted by the integ/sim harness.
        ...(this.config.executionRoleArn !== undefined
          ? { executionRoleArn: this.config.executionRoleArn }
          : {}),
        ...(this.config.taskRoleArn !== undefined ? { taskRoleArn: this.config.taskRoleArn } : {}),
        containerDefinitions: [
          {
            name: this.config.containerName ?? DEFAULT_WORKSPACE_CONTAINER,
            image: input.image,
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
            // Deliver per-workspace tokens (idle-agent, editor connection) via ECS
            // `secrets` (Secrets Manager) — ECS resolves them into the container env
            // at launch, never exposing them in DescribeTasks/CloudTrail the way
            // plaintext `environment` would.
            ...(input.injected !== undefined && input.injected.entries.length > 0
              ? { secrets: input.injected.entries }
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
        tags: costScopeTags(this.config),
      }),
    );
    const arn = required(out.taskDefinition?.taskDefinitionArn, "taskDefinitionArn");
    this.registered.set(cacheKey, arn);
    return arn;
  }

  /**
   * Ensure a per-workspace Secrets Manager secret (named
   * `edd/workspace/<wsId>/<purpose>`) holds `value`, and return its ARN. The value is
   * deterministic (a per-workspace HMAC) so it is stable across wakes; create it once,
   * update idempotently otherwise. Tagged so the reconciler's orphan-secret GC finds
   * every per-workspace secret (agent + connection) by the same workspace tag.
   */
  private async ensureWorkspaceSecret(
    client: SecretsManagerClient,
    wsId: string,
    purpose: "agent" | "connection",
    value: string,
  ): Promise<string> {
    const token = value;
    const name = `edd/workspace/${wsId}/${purpose}`;
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
            ...costScopeSecretTags(this.config),
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

  /** Deregister all but the newest `keepPerFamily` ACTIVE revisions of each
   * `edd-ws-*` workspace task-definition family. Per-launch secret injection forces a
   * new revision each time, so they grow unbounded otherwise; a running task keeps its
   * (now-inactive) revision and a wake registers a fresh one, so pruning old ones is
   * safe. Best-effort per revision (a deregister that errors is skipped, not fatal). */
  async pruneTaskDefinitions(keepPerFamily: number): Promise<number> {
    const families: string[] = [];
    for await (const page of paginateListTaskDefinitionFamilies(
      { client: this.client },
      { familyPrefix: WORKSPACE_TASKDEF_FAMILY_PREFIX, status: "ACTIVE" },
    )) {
      families.push(...(page.families ?? []));
    }
    let deregistered = 0;
    for (const family of families) {
      const arns: string[] = [];
      for await (const page of paginateListTaskDefinitions(
        { client: this.client },
        { familyPrefix: family, status: "ACTIVE", sort: "DESC" },
      )) {
        arns.push(...(page.taskDefinitionArns ?? []));
      }
      for (const arn of arns.slice(keepPerFamily)) {
        try {
          await this.client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
          deregistered += 1;
        } catch {
          // Best-effort: a revision in a transient state (or already inactive) is skipped.
        }
      }
    }
    return deregistered;
  }

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const dimensions = startupDimensions(input);
    // Secure path: stash the per-workspace tokens (idle-agent + editor connection)
    // in Secrets Manager and reference them from a per-workspace task def, so they
    // are never injected as plaintext env.
    const wsId = input.workspaceId;
    const entries: { name: string; valueFrom: string }[] = [];
    let agentViaSecret = false;
    let connectionViaSecret = false;
    if (this.secrets !== undefined) {
      const secrets = this.secrets;
      const agentSecret = this.config.agentSecret;
      if (agentSecret !== undefined) {
        const arn = await this.timeStartupPhase("secret-agent", dimensions, () =>
          this.ensureWorkspaceSecret(secrets, wsId, "agent", agentToken(agentSecret, wsId)),
        );
        entries.push({ name: "EDD_AGENT_TOKEN", valueFrom: arn });
        agentViaSecret = true;
      }
      const connectionSecret = this.config.connectionSecret;
      if (connectionSecret !== undefined) {
        const arn = await this.timeStartupPhase("secret-connection", dimensions, () =>
          this.ensureWorkspaceSecret(
            secrets,
            wsId,
            "connection",
            deriveWorkspaceToken(connectionSecret, wsId),
          ),
        );
        entries.push({ name: "CONNECTION_TOKEN", valueFrom: arn });
        connectionViaSecret = true;
      }
    }
    const injected = entries.length > 0 ? { wsId, entries } : undefined;
    const taskDefInput = {
      image: input.baseImage,
      resources: input.resources,
      ...(injected === undefined ? {} : { injected }),
    };
    const taskDef = await this.timeStartupPhase("task-definition", dimensions, () =>
      this.ensureTaskDef(taskDefInput),
    );

    const workspaceEnv = workspaceEnvironment(
      this.config,
      wsId,
      { url: input.repoUrl, ref: input.repoRef },
      { omitAgentToken: agentViaSecret, omitConnectionToken: connectionViaSecret },
      input.editor,
    );

    const runTaskCommand = (td: string): RunTaskCommand =>
      new RunTaskCommand({
        cluster: this.cluster(),
        taskDefinition: td,
        launchType: "FARGATE",
        // Tag the task with its workspace so the reconciler's orphan-task reaper can
        // enumerate workspace tasks (and only those) and read the workspace id back.
        tags: [{ key: WORKSPACE_TAG_KEY, value: input.workspaceId }, ...costScopeTags(this.config)],
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
                ? { sizeInGiB: input.resources.volumeGiB }
                : { snapshotId: input.fromSnapshot }),
              terminationPolicy: { deleteOnTermination: true },
              tagSpecifications: [
                {
                  resourceType: "volume",
                  tags: costScopeTags(this.config),
                },
              ],
            },
          },
        ],
      });

    const out = await this.timeStartupPhase("run-task-api", dimensions, async () => {
      try {
        return await this.client.send(runTaskCommand(taskDef));
      } catch (e) {
        // The in-process task-def ARN cache can outlive the revision: the reconciler
        // prunes old revisions in a DIFFERENT process, and a per-workspace secret can be
        // recreated with a new ARN. A cached ARN then points at an INACTIVE/missing task
        // definition, and RunTask fails — permanently, since the cache would keep
        // returning the dead ARN. Evict the entry, re-register a fresh revision, and
        // retry once so a pruned/stale task def self-heals instead of bricking the wake.
        if (!isInactiveTaskDefError(e)) throw e;
        this.registered.delete(this.taskDefCacheKey(taskDefInput));
        const fresh = await this.ensureTaskDef(taskDefInput);
        return await this.client.send(runTaskCommand(fresh));
      }
    });
    // RunTask returns HTTP 200 with an EMPTY tasks[] and a populated failures[] when
    // placement fails for a recoverable reason (RESOURCE:MEMORY / RESOURCE:CPU — no
    // Fargate capacity, AGENT, subnet/ENI exhaustion). It does not throw. Surface the
    // real reason instead of the misleading generic "missing taskArn" the bare
    // `required()` would raise, so the operator (and retry logic) sees "no capacity".
    const failure = out.failures?.[0];
    if (failure !== undefined) {
      const detail = failure.detail === undefined ? "" : ` (${failure.detail})`;
      throw new Error(`ECS RunTask failed to place task: ${failure.reason ?? "unknown"}${detail}`);
    }
    const arn = required(out.tasks?.[0]?.taskArn, "taskArn");
    // The task is now launched. If it never becomes ready (stops mid-boot, or the
    // readiness poll times out), stop it before propagating — otherwise a failed
    // launch leaks a running Fargate task and its managed EBS volume (the caller
    // never receives this ARN, so it cannot compensate; the managed volume's
    // deleteOnTermination then reaps the volume with the stopped task).
    try {
      const ready = await this.timeStartupPhase("ecs-ready", dimensions, () =>
        this.awaitTaskReady(arn),
      );
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

  private async timeStartupPhase<T>(
    phase: string,
    dimensions: MetricDimensions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.metrics?.timing(METRIC_WORKSPACE_STARTUP_PHASE_MS, Date.now() - started, {
        ...dimensions,
        phase,
        outcome: "ok",
      });
      return result;
    } catch (err) {
      this.metrics?.timing(METRIC_WORKSPACE_STARTUP_PHASE_MS, Date.now() - started, {
        ...dimensions,
        phase,
        outcome: "error",
      });
      this.metrics?.count(METRIC_WORKSPACE_STARTUP_PHASE_FAILED, 1, {
        ...dimensions,
        phase,
      });
      throw err;
    }
  }

  async stopTask(id: TaskId): Promise<void> {
    try {
      await this.client.send(
        new StopTaskCommand({
          cluster: this.cluster(),
          task: id,
          reason: "edd: workspace lifecycle stop (scale-to-zero/delete)",
        }),
      );
    } catch (err) {
      // Idempotent: a task ECS already reaped/expired is already in the desired
      // stopped state, so a retried lifecycle stop or failed-launch cleanup must
      // not surface a spurious error. ECS reports a missing task as
      // ResourceNotFoundException, and StopTask on an unknown task id as
      // InvalidParameterException ("task was not found") — both mean "already
      // gone". Any other error name is a real failure and is rethrown.
      if (err instanceof Error && STOP_TASK_ALREADY_GONE.has(err.name)) return;
      throw err;
    }
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
      // A task returned in `failures[]` (throttle/transient MISSING) was NOT
      // described, so it would be silently dropped from the set the reaper treats
      // as "existing" — a true orphan could then be missed (leaking a Fargate task
      // + its EBS volume) while `scanned` undercounts invisibly. Refuse to act on
      // an incomplete fleet picture: throw so the sweep is counted as failed.
      if (out.failures !== undefined && out.failures.length > 0) {
        const detail = out.failures.map((f) => `${f.arn ?? "?"}: ${f.reason ?? "?"}`).join(", ");
        throw new Error(
          `DescribeTasks reported ${String(out.failures.length)} failure(s): ${detail}`,
        );
      }
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
    if (status === undefined) {
      // The task was not described. ECS returns it in failures[] with reason MISSING
      // once the task is genuinely gone (stopped + pruned past the retention window) —
      // the loss condition this drift check exists to catch, so MISSING → stopped. But
      // any OTHER failure reason (e.g. a cluster/permission problem) is NOT evidence the
      // task is gone; mapping it to "stopped" would tear down a live workspace, so fail
      // loud rather than silently treating an API-level problem as task loss (§6.5).
      const failure = out.failures?.[0];
      if (failure !== undefined && failure.reason !== "MISSING") {
        throw new Error(
          `ECS DescribeTasks for ${id} returned an unexpected failure: ${failure.reason ?? "unknown"}`,
        );
      }
      return "stopped";
    }
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
    if (cluster === undefined) {
      return {
        name,
        status: "not found",
        runningTasks: 0,
        pendingTasks: 0,
        activeServices: 0,
        registeredContainerInstances: 0,
      };
    }
    return {
      name,
      status: cluster.status ?? "unknown",
      runningTasks: cluster.runningTasksCount ?? 0,
      pendingTasks: cluster.pendingTasksCount ?? 0,
      activeServices: cluster.activeServicesCount ?? 0,
      registeredContainerInstances: cluster.registeredContainerInstancesCount ?? 0,
    };
  }

  /**
   * Current desired/running replica counts of a long-lived ECS **service** (thin
   * DescribeServices). Used by the reconciler's control-plane idle-shutdown sweep to
   * read the control-plane service's current scale (and by the wake path to know when
   * it is at zero). Fails loud (§6.5) when the named service does not exist — an
   * INACTIVE (deleted) service or one ECS returns only in `failures[]` is NOT a live
   * service to reason about, so silently treating it as scale 0 would be wrong.
   */
  async describeService(
    serviceName: string,
  ): Promise<{ desiredCount: number; runningCount: number }> {
    const out = await this.client.send(
      new DescribeServicesCommand({ cluster: this.cluster(), services: [serviceName] }),
    );
    const service = out.services?.find((s) => s.status !== "INACTIVE");
    if (service === undefined) {
      const failure = out.failures?.[0];
      const detail =
        failure === undefined
          ? ""
          : ` (${failure.reason ?? "unknown"}${failure.detail ? `: ${failure.detail}` : ""})`;
      throw new Error(
        `ECS DescribeServices found no active service '${serviceName}' in cluster ${this.cluster()}${detail}`,
      );
    }
    return {
      desiredCount: required(service.desiredCount, "service desiredCount"),
      runningCount: required(service.runningCount, "service runningCount"),
    };
  }

  /**
   * Set an ECS **service's** desired replica count (thin UpdateService). The
   * reconciler's idle-shutdown sweep calls this with `0` to scale the control plane to
   * zero after a quiet period; the wake path calls it with the active count to bring it
   * back. UpdateService raises on a missing service, so this fails loud rather than
   * silently no-op'ing on a typo'd service name.
   */
  async scaleService(serviceName: string, desiredCount: number): Promise<void> {
    await this.client.send(
      new UpdateServiceCommand({
        cluster: this.cluster(),
        service: serviceName,
        desiredCount,
      }),
    );
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
   * ECS_TASK_ROLE_ARN, CONTROL_PLANE_URL, EDD_AGENT_SECRET, EDD_CONNECTION_SECRET.
   * Throws loudly if required vars are absent. Workspace CPU/RAM/disk are persisted
   * per workspace and supplied to runTask.
   */
  static fromEnv(
    agentSecret?: string,
    connectionSecret?: string,
    metrics?: MetricSink,
  ): EcsComputeProvider {
    const subnets = process.env.ECS_SUBNETS?.split(",").filter(Boolean) ?? [];
    const securityGroups = process.env.ECS_SECURITY_GROUPS?.split(",").filter(Boolean);
    const ebsRoleArn = process.env.ECS_EBS_ROLE_ARN;
    if (subnets.length === 0) throw new Error("COMPUTE_PROVIDER=ecs requires ECS_SUBNETS");
    if (!ebsRoleArn) throw new Error("COMPUTE_PROVIDER=ecs requires ECS_EBS_ROLE_ARN");
    const heartbeatIntervalS =
      positiveIntEnv("EDD_HEARTBEAT_INTERVAL_S") ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    return new EcsComputeProvider({
      client: EcsComputeProvider.client(),
      ...(metrics === undefined ? {} : { metrics }),
      // Always wire the Secrets Manager client in the ECS path. Injecting per-workspace
      // tokens needs the agent/connection secret VALUES (present on the web app), but
      // ENUMERATING and REAPING orphaned runtime secrets (the reconciler's GC) needs only
      // the client — and the reconciler constructs the provider WITHOUT secret values, so
      // gating the client on those values left `listWorkspaceAgentSecrets`/
      // `deleteAgentSecret` permanently inert there, leaking two paid secrets per
      // workspace forever. The client alone does no I/O and is safe to always create.
      secretsClient: EcsComputeProvider.secretsClient(),
      config: {
        cluster: process.env.ECS_CLUSTER,
        subnets,
        securityGroups,
        ebsRoleArn,
        executionRoleArn: process.env.ECS_EXECUTION_ROLE_ARN,
        taskRoleArn: process.env.ECS_TASK_ROLE_ARN,
        // Public-subnet egress (image pulls; sim route-table model needs it too).
        assignPublicIp: process.env.ECS_ASSIGN_PUBLIC_IP === "1",
        controlPlaneUrl: process.env.CONTROL_PLANE_URL,
        agentSecret,
        connectionSecret,
        logGroupName: process.env.ECS_LOG_GROUP_WORKSPACES,
        heartbeatIntervalS,
        costScope: COST_SCOPE,
      },
    });
  }
}
