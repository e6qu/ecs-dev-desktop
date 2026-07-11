// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/**
 * API-first contracts: the single source of truth for the control-plane API.
 * The Next.js route handlers validate against these, and `@edd/api-client`
 * consumes the inferred types — UI and external clients use the same surface.
 */

/** The body every error response carries (`{ error: <message> }`) — see the API
 * helpers + `domainErrorResponse` in `apps/web/lib/api.ts`. The client parses it
 * to surface the real reason (e.g. "workspace quota reached") instead of a status. */
export const errorResponse = z.object({
  error: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

export const workspaceState = z.enum([
  "provisioning",
  "running",
  "idle",
  "stopping",
  "stopped",
  "deleting",
  "terminated",
  "error",
]);
export type WorkspaceStateDto = z.infer<typeof workspaceState>;

/** Durable convergence intent (independent of the observed `state`). */
export const desiredState = z.enum(["present", "deleted"]);
export type DesiredStateDto = z.infer<typeof desiredState>;

/** A user-initiated lifecycle operation the UI may offer for a workspace. */
export const workspaceAction = z.enum([
  "start",
  "stop",
  "cancelStop",
  "snapshot",
  "delete",
  "undelete",
  "retry",
]);
export type WorkspaceActionDto = z.infer<typeof workspaceAction>;

/** Which primary interface a workspace serves (mirrors `@edd/core`'s EditorKind):
 * openvscode = OpenVSCode Server; monaco = the first-party lightweight editor;
 * terminal = EDD's multi-tab terminal with the Claude/Codex CLIs on PATH;
 * opencode = opencode's vendor local web client. */
export const editorKind = z.enum(["openvscode", "monaco", "terminal", "opencode"]);
export type EditorKindDto = z.infer<typeof editorKind>;

export const workspaceCpuUnits = z.union([
  z.literal(512),
  z.literal(1024),
  z.literal(2048),
  z.literal(4096),
]);
export type WorkspaceCpuUnitsDto = z.infer<typeof workspaceCpuUnits>;

export const workspaceMemoryMiB = z.union([
  z.literal(2048),
  z.literal(4096),
  z.literal(8192),
  z.literal(16384),
]);
export type WorkspaceMemoryMiBDto = z.infer<typeof workspaceMemoryMiB>;

export const workspaceVolumeGiB = z.union([
  z.literal(8),
  z.literal(16),
  z.literal(32),
  z.literal(64),
]);
export type WorkspaceVolumeGiBDto = z.infer<typeof workspaceVolumeGiB>;

export const workspaceResources = z
  .object({
    cpuUnits: workspaceCpuUnits,
    memoryMiB: workspaceMemoryMiB,
    volumeGiB: workspaceVolumeGiB,
  })
  .refine(
    (r) => {
      switch (r.cpuUnits) {
        case 512:
          return r.memoryMiB === 2048 || r.memoryMiB === 4096;
        case 1024:
          return r.memoryMiB === 2048 || r.memoryMiB === 4096 || r.memoryMiB === 8192;
        case 2048:
          return r.memoryMiB === 4096 || r.memoryMiB === 8192 || r.memoryMiB === 16384;
        case 4096:
          return r.memoryMiB === 8192 || r.memoryMiB === 16384;
      }
    },
    { message: "memoryMiB is not valid for cpuUnits" },
  );
export type WorkspaceResourcesDto = z.infer<typeof workspaceResources>;

/** The RBAC roles (mirrors `@edd/authz` `ROLES` — kept here so the contract has no dep on authz;
 * the role-mapping test pins them in sync). A closed enum, not a bare string, so a typo'd/unknown
 * role can't ride a DTO. */
export const role = z.enum(["viewer", "developer", "admin"]);
export type RoleDto = z.infer<typeof role>;

export const workspace = z.object({
  id: z.string(),
  ownerId: z.string(),
  // The owner's role at create time — lets the admin quota view flag a workspace against its
  // owner's per-role limit. Absent on records predating the field.
  ownerRole: role.optional(),
  /** Who started the workspace (email when known) — shown on the card/status. */
  ownerEmail: z.email().optional(),
  baseImage: z.string(),
  editor: editorKind.optional(),
  resources: workspaceResources,
  state: workspaceState,
  createdAt: z.iso.datetime(),
  /** Last activity/transition timestamp — what the status page's phase-elapsed
   * timer counts from (resets on wake, so it times the current launch). */
  lastActivity: z.iso.datetime().optional(),
  /** When a manual (cancelable) stop was requested — set while `stopping`. */
  stopRequestedAt: z.iso.datetime().optional(),
  // The repo cloned into the session ("one repo per session"), when any. Lets
  // the credential broker pick the right GitHub App installation by repo owner.
  repoUrl: z.string().optional(),
  // The lifecycle actions valid from this state — server-computed (from the core
  // state machine) so the UI renders buttons from data, not a client-side mirror.
  availableActions: z.array(workspaceAction),
  // Resolved catalog presentation for `baseImage` (joined server-side so the UI
  // doesn't re-fetch + join the catalog). Absent when the image isn't in the catalog.
  imageName: z.string().optional(),
  imageDescription: z.string().optional(),
  imageTags: z.array(z.string()).optional(),
  imageTools: z.array(z.string()).optional(),
  // The ready-to-run `ssh …` connect command, when the SSH subdomain is configured —
  // built server-side from deployment config so a reskin needn't know the convention.
  sshCommand: z.string().optional(),
  // Functional usability self-report (is the desktop actually usable, not just
  // "running"): surfaced on the owner's card so a degraded-but-running workspace shows.
  functional: z.enum(["ok", "degraded"]).optional(),
  /** Why the workspace is degraded / failed to launch (agent report or launch error). */
  functionalDetail: z.string().optional(),
  // Home-volume usage from the agent's functional self-report (bytes).
  diskUsedBytes: z.number().nonnegative().optional(),
  diskTotalBytes: z.number().positive().optional(),
  latestSnapshotId: z.string().optional(),
  latestSnapshotAt: z.iso.datetime().optional(),
  snapshotIntervalMs: z.number().int().positive().optional(),
  /** When teardown finished — the undelete retention window counts from here. */
  terminatedAt: z.iso.datetime().optional(),
  /** Owner-controlled spectate flag: viewers may watch a read-only mirror. */
  shareEnabled: z.boolean().optional(),
});
export type WorkspaceDto = z.infer<typeof workspace>;

/** Config-sync report: is the running deployment wired the way it should be? */
export const configCheck = z.object({
  name: z.string(),
  status: z.enum(["ok", "drift", "unknown"]),
  detail: z.string(),
});
/** The resolved AWS caller identity the control plane runs as (sts:GetCallerIdentity). */
export const iamIdentity = z.object({
  account: z.string(),
  callerArn: z.string(),
  principalArn: z.string().nullable(),
});
export type IamIdentityDto = z.infer<typeof iamIdentity>;
export const configSyncReport = z.object({
  inSync: z.boolean(),
  checks: z.array(configCheck),
  /** Present on a real deployment once the caller identity resolves. */
  identity: iamIdentity.optional(),
});
export type ConfigSyncReportDto = z.infer<typeof configSyncReport>;

/** Optional self-reports carried on a heartbeat (in-workspace agent). */
export const heartbeatRequest = z.object({
  /** Whether the workspace saw REAL usage since the last beat (terminal/editor
   * interaction, running compute) — the idle-agent's activity self-report. `false`
   * means "alive but unused": the control plane records the functional report but
   * does NOT refresh `lastActivity`, so the reconciler's idle window keeps aging
   * and an untouched workspace scales to zero. Absent (or `true`) counts as
   * activity — a session-authed browser/API heartbeat IS a user action. */
  active: z.boolean().optional(),
  functional: z
    .object({
      /** OpenVSCode reachable on the workspace port. */
      ide: z.boolean(),
      /** The workspace home directory is writable. */
      workspace: z.boolean(),
      /** Home-volume (EBS) usage, bytes — measured in-container with df. */
      disk: z
        .object({
          usedBytes: z.number().nonnegative(),
          totalBytes: z.number().positive(),
        })
        .optional(),
    })
    .optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequest>;

/** Toggle the owner's spectate (read-only mirror) flag. */
export const shareRequest = z.object({ enabled: z.boolean() });
export type ShareRequest = z.infer<typeof shareRequest>;

/** A security event reported by the in-workspace guard (agent machine-auth). */
export const securityEventRequest = z.object({
  kind: z.enum(["privilege_attempt"]),
  /** The guarded tool the workspace tried to run (e.g. "docker", "sudo"). */
  tool: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/),
});
export type SecurityEventRequest = z.infer<typeof securityEventRequest>;

export const MIN_SNAPSHOT_INTERVAL_MS = 60 * 1000;
export const MAX_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const createWorkspaceRequest = z.object({
  baseImage: z.string().trim().min(1),
  /** Optional git repo to clone into the session at first boot ("one repo per
   * session"). HTTPS URL; private repos use the owner's git credential. */
  repoUrl: z.url().startsWith("https://").optional(),
  /** Optional branch/tag/SHA to check out (defaults to the repo's default). */
  repoRef: z.string().trim().min(1).max(255).optional(),
  /** Per-session interface override; absent = the base image's catalog choice. */
  editor: editorKind.optional(),
  /** Per-workspace scheduled snapshot cadence. Absent = deployment default. */
  snapshotIntervalMs: z
    .number()
    .int()
    .min(MIN_SNAPSHOT_INTERVAL_MS)
    .max(MAX_SNAPSHOT_INTERVAL_MS)
    .optional(),
  /** Per-workspace Fargate task size. Absent = product default. */
  resources: workspaceResources.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequest>;

export const updateWorkspaceRequest = z
  .object({
    snapshotIntervalMs: z
      .number()
      .int()
      .min(MIN_SNAPSHOT_INTERVAL_MS)
      .max(MAX_SNAPSHOT_INTERVAL_MS)
      .optional(),
  })
  .refine((p) => p.snapshotIntervalMs !== undefined, {
    message: "at least one field is required",
  });
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequest>;

export const listWorkspacesResponse = z.object({
  workspaces: z.array(workspace),
});
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponse>;

/** One workspace's container (boot/runtime) log lines — the owner-facing slice of
 * the CloudWatch container stream, surfaced on the workspace status page.
 * `available` is explicit so the UI can distinguish "no lines yet" from "no log
 * source in this environment" (the `note` says which). */
export const workspaceLogs = z.object({
  available: z.boolean(),
  note: z.string(),
  lines: z.array(
    z.object({
      at: z.iso.datetime(),
      level: z.enum(["info", "warn", "error"]),
      source: z.string(),
      message: z.string(),
    }),
  ),
});
export type WorkspaceLogsDto = z.infer<typeof workspaceLogs>;

/** One metric series for the workspace monitoring view. `available` is explicit
 * (§6.5): false + note when this environment has no metrics source (fakes/sim) or
 * the read failed; true with empty points just means no datapoints yet. */
export const monitoringSeries = z.object({
  available: z.boolean(),
  note: z.string(),
  points: z.array(z.object({ at: z.iso.datetime(), value: z.number() })),
});
export type MonitoringSeriesDto = z.infer<typeof monitoringSeries>;

/** Per-workspace monitoring: provisioned sizing, uptime, cost so far (incl. the
 * snapshot-storage line), utilization series, and disk/IOPS detail. */
export const workspaceMonitoring = z.object({
  workspaceId: z.string(),
  state: workspaceState,
  resources: z.object({
    vcpu: z.number().positive(),
    memoryGib: z.number().positive(),
    volumeGib: z.number().positive(),
  }),
  uptime: z.object({
    createdAt: z.iso.datetime(),
    runningMs: z.number().nonnegative(),
    stoppedMs: z.number().nonnegative(),
  }),
  /** Absent until the workspace has any priced lifecycle events. */
  cost: z
    .object({
      computeUsd: z.number(),
      volumeUsd: z.number(),
      snapshotUsd: z.number(),
      totalUsd: z.number(),
    })
    .optional(),
  /** Task CPU utilization, vCPU-units average (Container Insights, task-definition
   * family scope — exact per-workspace when each workspace runs its own family). */
  cpu: monitoringSeries,
  /** Task memory utilization, MiB average (same source/scope as `cpu`). */
  memory: monitoringSeries,
  /** Per-volume EBS read/write operations (Sum per period). */
  diskReadOps: monitoringSeries,
  diskWriteOps: monitoringSeries,
  /** gp3 baseline IOPS provisioned for the home volume. */
  iopsBaseline: z.number().positive(),
  disk: z.object({
    volumeGib: z.number().positive(),
    usedBytes: z.number().nonnegative().optional(),
    totalBytes: z.number().positive().optional(),
  }),
});
export type WorkspaceMonitoringDto = z.infer<typeof workspaceMonitoring>;

// --- Admin: per-workspace Inspect (full detail + derived timeline) ---

export const workspaceDetail = z.object({
  id: z.string(),
  ownerId: z.string(),
  /** Owner's email — the identity the proxy matches a caller against for
   * per-workspace access. Absent on records created without a session email.
   * Validated as an email (not a bare string) so a malformed value is rejected at
   * the wire boundary, matching `@edd/core`'s `email()` smart constructor. */
  ownerEmail: z.email().optional(),
  /** The owner's role at create time (persisted), for the admin quota view. */
  ownerRole: role.optional(),
  /** Git repo cloned into the session, if any ("one repo per session"). */
  repoUrl: z.string().optional(),
  baseImage: z.string(),
  editor: editorKind.optional(),
  resources: workspaceResources,
  state: workspaceState,
  /** Durable intent: should this workspace exist (`present`) or be torn down
   * (`deleted`). Absent on records predating the field ⇒ treated `present`. */
  desiredState: desiredState.optional(),
  /** When a delete was requested (the `deleting` tombstone began), if any. */
  deleteRequestedAt: z.iso.datetime().optional(),
  stopRequestedAt: z.iso.datetime().optional(),
  stopRequestedBy: z.string().optional(),
  createdAt: z.iso.datetime(),
  lastActivity: z.iso.datetime(),
  volumeId: z.string().optional(),
  taskId: z.string().optional(),
  latestSnapshotId: z.string().optional(),
  latestSnapshotAt: z.iso.datetime().optional(),
  snapshotIntervalMs: z.number().int().positive().optional(),
  /** Private IP of the running task's ENI; absent when stopped/scaled-to-zero. */
  sshHost: z.string().optional(),
  /** Functional usability self-report from the in-workspace agent (is the desktop
   * actually usable, not just running): `ok` / `degraded` + detail + when. */
  functional: z.enum(["ok", "degraded"]).optional(),
  functionalDetail: z.string().optional(),
  functionalAt: z.iso.datetime().optional(),
  diskUsedBytes: z.number().nonnegative().optional(),
  diskTotalBytes: z.number().positive().optional(),
  terminatedAt: z.iso.datetime().optional(),
  shareEnabled: z.boolean().optional(),
  /** Lifecycle actions valid from this state (server-computed; see {@link workspace}). */
  availableActions: z.array(workspaceAction),
});
export type WorkspaceDetailDto = z.infer<typeof workspaceDetail>;

export const timelineEvent = z.object({
  at: z.iso.datetime(),
  event: z.string(),
  detail: z.string(),
});
export type TimelineEventDto = z.infer<typeof timelineEvent>;

export const workspaceInspection = z.object({
  workspace: workspaceDetail,
  timeline: z.array(timelineEvent),
});
export type WorkspaceInspectionDto = z.infer<typeof workspaceInspection>;

// --- Base-image catalog (admin-managed golden images users launch from) ---

export const baseImageEntry = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  tools: z.array(z.string()),
  enabled: z.boolean(),
  editor: editorKind,
  createdAt: z.iso.datetime(),
});
export type BaseImageEntryDto = z.infer<typeof baseImageEntry>;

export const createBaseImageRequest = z.object({
  name: z.string().trim().min(1),
  image: z.string().trim().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  editor: editorKind.optional(),
});
export type CreateBaseImageRequest = z.infer<typeof createBaseImageRequest>;

/** Partial update; the id is immutable. At least one field. */
export const updateBaseImageRequest = z
  .object({
    name: z.string().trim().min(1).optional(),
    image: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    editor: editorKind.optional(),
  })
  .refine(
    (p) =>
      p.name !== undefined ||
      p.image !== undefined ||
      p.description !== undefined ||
      p.tags !== undefined ||
      p.tools !== undefined ||
      p.enabled !== undefined ||
      p.editor !== undefined,
    {
      message: "at least one field is required",
    },
  );
export type UpdateBaseImageRequest = z.infer<typeof updateBaseImageRequest>;

export const listBaseImagesResponse = z.object({
  baseImages: z.array(baseImageEntry),
});
export type ListBaseImagesResponse = z.infer<typeof listBaseImagesResponse>;

// --- Admin: EBS snapshots ---

/** One EBS snapshot as the admin snapshot console sees it: storage attribution plus
 * whether a live/stopped workspace still depends on it. A `retained` snapshot with no
 * `workspaceId` and `referenced: false` is the safe-to-purge orphan the view targets. */
export const adminSnapshot = z.object({
  id: z.string(),
  /** The workspace this snapshot was taken for (`edd:workspace-id` tag); absent =
   * unattributed (typically a legacy snapshot predating the tag). */
  workspaceId: z.string().optional(),
  /** Logical size the snapshot pins, in GiB (EBS VolumeSize); absent if unreported. */
  sizeGiB: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
  /** Tagged retained (kept past workspace delete) — orphan-GC never reaps these, so
   * they accumulate and are the main purge target. */
  retained: z.boolean(),
  /** A live/stopped workspace still lists this snapshot as its restore point. Purging a
   * referenced snapshot is refused (it would strand the workspace). */
  referenced: z.boolean(),
});
export type AdminSnapshotDto = z.infer<typeof adminSnapshot>;

export const listSnapshotsResponse = z.object({
  snapshots: z.array(adminSnapshot),
});
export type ListSnapshotsResponse = z.infer<typeof listSnapshotsResponse>;

/** Result of purging a single snapshot. */
export const purgeSnapshotResponse = z.object({
  id: z.string(),
  purged: z.boolean(),
});
export type PurgeSnapshotResponse = z.infer<typeof purgeSnapshotResponse>;

/** Result of the bulk "purge all unreferenced" action: the ids actually reaped. */
export const purgeUnreferencedSnapshotsResponse = z.object({
  purged: z.number().int().nonnegative(),
  snapshotIds: z.array(z.string()),
});
export type PurgeUnreferencedSnapshotsResponse = z.infer<typeof purgeUnreferencedSnapshotsResponse>;

// --- Admin: health board ---

export const healthStatus = z.enum(["ok", "degraded", "down", "unknown"]);
export type HealthStatusDto = z.infer<typeof healthStatus>;

export const componentHealth = z.object({
  component: z.string(),
  status: healthStatus,
  detail: z.string().optional(),
});
export type ComponentHealthDto = z.infer<typeof componentHealth>;

export const healthReport = z.object({
  status: healthStatus,
  components: z.array(componentHealth),
  checkedAt: z.iso.datetime(),
});
export type HealthReportDto = z.infer<typeof healthReport>;

// --- Admin: infrastructure view (cluster + topology + fleet) ---

export const clusterInfo = z.object({
  name: z.string(),
  status: z.string(),
  runningTasks: z.number().int().nonnegative(),
  pendingTasks: z.number().int().nonnegative(),
  activeServices: z.number().int().nonnegative(),
  registeredContainerInstances: z.number().int().nonnegative(),
});
export type ClusterInfoDto = z.infer<typeof clusterInfo>;

export const fleetStats = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  byState: z.record(workspaceState, z.number().int().nonnegative()),
});
export type FleetStatsDto = z.infer<typeof fleetStats>;

export const topologyNode = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["client", "edge", "compute", "data", "storage", "worker"]),
  description: z.string(),
  status: healthStatus,
  detail: z.string().optional(),
});
export type TopologyNodeDto = z.infer<typeof topologyNode>;

export const topologyEdge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
});
export type TopologyEdgeDto = z.infer<typeof topologyEdge>;

export const infrastructureReport = z.object({
  health: healthReport,
  cluster: clusterInfo,
  fleet: fleetStats,
  topology: z.object({
    nodes: z.array(topologyNode),
    edges: z.array(topologyEdge),
  }),
});
export type InfrastructureReportDto = z.infer<typeof infrastructureReport>;

// --- Admin: audit feed (derived now; CloudTrail on AWS) ---

export const auditEvent = z.object({
  at: z.iso.datetime(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  detail: z.string(),
  resources: workspaceResources.optional(),
});
export type AuditEventDto = z.infer<typeof auditEvent>;

export const auditFeedResponse = z.object({
  events: z.array(auditEvent),
});
export type AuditFeedResponse = z.infer<typeof auditFeedResponse>;

// --- Admin: cost report (prices the lifecycle audit ledger) ---

export const costBreakdown = z.object({
  // Costs and durations are domain-nonnegative; a negative value from a buggy pricer
  // is non-representable (fails the contract) rather than silently surfacing in a report.
  computeUsd: z.number().nonnegative(),
  volumeUsd: z.number().nonnegative(),
  snapshotUsd: z.number().nonnegative(),
  totalUsd: z.number().nonnegative(),
  runningMs: z.number().int().nonnegative(),
  stoppedMs: z.number().int().nonnegative(),
  /** Teardown-window ms (delete request → termination); bills volume + snapshot. */
  teardownMs: z.number().int().nonnegative(),
});
export type CostBreakdownDto = z.infer<typeof costBreakdown>;

export const costPricing = z.object({
  fargateVcpuHourUsd: z.number(),
  fargateGbHourUsd: z.number(),
  ebsGbMonthUsd: z.number(),
  snapshotGbMonthUsd: z.number(),
});
export type CostPricingDto = z.infer<typeof costPricing>;

export const costSizing = z.object({
  vcpu: z.number(),
  memoryGib: z.number(),
  volumeGib: z.number(),
});
export type CostSizingDto = z.infer<typeof costSizing>;

export const sessionCost = costBreakdown.extend({
  workspaceId: z.string(),
  owner: z.string(),
  sizing: costSizing,
  // The session's lifecycle state, or the `unknown` sentinel the cost model emits for a
  // priced session whose workspace record is gone (the ledger is append-only, so a
  // deleted session still prices). A closed set, not a bare string, so a typo'd/unknown
  // state can't ride the cost DTO into the admin UI (mirrors `workspace.state`).
  state: workspaceState.or(z.literal("unknown")),
  terminated: z.boolean(),
});
export type SessionCostDto = z.infer<typeof sessionCost>;

export const userCost = costBreakdown.extend({
  owner: z.string(),
  sessions: z.number(),
});
export type UserCostDto = z.infer<typeof userCost>;

export const costReport = z.object({
  generatedAt: z.iso.datetime(),
  windowStart: z.iso.datetime(),
  pricing: costPricing,
  total: costBreakdown,
  byUser: z.array(userCost),
  bySession: z.array(sessionCost),
  unpriced: z.array(z.object({ workspaceId: z.string(), reason: z.string() })),
});
export type CostReport = z.infer<typeof costReport>;

// --- Admin: quota report (per-role limits + per-user usage) ---

export const quotaReport = z.object({
  /** Per-role workspace caps (`limit: null` = unlimited). A negative or fractional
   * cap is non-representable — a misconfigured limit fails the contract, not silently
   * drives quota enforcement. */
  limits: z.array(z.object({ role, limit: z.number().int().nonnegative().nullable() })),
  /** Current workspace count per owner, busiest first. `role`/`limit` are present when the owner's
   * role is known (persisted on a workspace they own); `atOrOver` flags a count at/over the limit —
   * against the owner's own per-role cap when known, else against the strictest finite cap. */
  usage: z.array(
    z.object({
      owner: z.string(),
      count: z.number().int().nonnegative(),
      role: role.optional(),
      limit: z.number().int().nonnegative().nullable(),
      atOrOver: z.boolean(),
    }),
  ),
});
export type QuotaReportDto = z.infer<typeof quotaReport>;

// --- Admin: overview (at-a-glance fleet + catalog counts) ---

export const overviewReport = z.object({
  workspaces: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
  }),
  /** Distinct owners with at least one workspace. */
  activeUsers: z.number().int().nonnegative(),
  baseImages: z.object({
    total: z.number().int().nonnegative(),
    enabled: z.number().int().nonnegative(),
  }),
  /** Per-state counts, non-zero states only (busiest breakdown). */
  byState: z.array(z.object({ state: workspaceState, count: z.number().int().nonnegative() })),
});
export type OverviewReportDto = z.infer<typeof overviewReport>;

/** Time window for the cost report: `all` = full lifetime, the rest = last N days. */
export const costWindow = z.enum(["all", "1d", "7d", "30d"]);
export type CostWindow = z.infer<typeof costWindow>;

/** Days each {@link costWindow} spans; `null` = all-time (price the whole ledger). */
export const COST_WINDOW_DAYS: Record<CostWindow, number | null> = {
  all: null,
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

/** Response of `POST /api/admin/costs/rollup` (regenerate the cost checkpoints). */
export const costRollupResponse = z.object({ ok: z.literal(true) });
export type CostRollupResponse = z.infer<typeof costRollupResponse>;

/** Parse a possibly-absent `?window=` value to a valid window: an absent param
 * defaults to `all`, but an explicit invalid value is rejected (`.default` not
 * `.catch`, so the route's boundary `safeParse` → 400 actually fires — `.catch`
 * would silently swallow `?window=garbage` into `all`). */
export const costReportQuery = z.object({ window: costWindow.default("all") });
export type CostReportQuery = z.infer<typeof costReportQuery>;

// --- Admin: log streams (control-plane derived now; CloudWatch on AWS) ---

export const logStream = z.enum(["control-plane", "reconciler", "container"]);
export type LogStreamDto = z.infer<typeof logStream>;

export const logLine = z.object({
  at: z.iso.datetime(),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
});
export type LogLineDto = z.infer<typeof logLine>;

export const logStreamResult = z.object({
  stream: logStream,
  available: z.boolean(),
  note: z.string(),
  lines: z.array(logLine),
});
export type LogStreamResultDto = z.infer<typeof logStreamResult>;

// --- SSH: cert issuance + connect-info ---

/** Algorithms our SSH CA will sign — modern OpenSSH public-key types, including
 * FIDO/U2F (`sk-`) variants. Legacy `ssh-dss` is intentionally excluded. */
const SSH_PUBLIC_KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;

/** A single-line OpenSSH `authorized_keys` entry: `<type> <base64-blob> [comment]`.
 * Validating shape here (the single source of API truth) turns hostile/garbage
 * input into a 400 at the contract boundary instead of a 500 from `ssh-keygen`. */
const SSH_PUBLIC_KEY_RE = new RegExp(
  `^(?:${SSH_PUBLIC_KEY_TYPES.map((t) => t.replace(/[.\-@]/g, "\\$&")).join("|")}) ` +
    `[A-Za-z0-9+/]+={0,3}(?: [^\\r\\n]*)?$`,
);
/** Cap on the whole entry — a 4096-bit RSA key is ~750 chars; 16 KiB is ample
 * and rejects absurd payloads. */
const SSH_PUBLIC_KEY_MAX = 16 * 1024;

/** A single-line OpenSSH public key, validated at the boundary: one line, known
 * key type, base64 blob, no newlines (so it can't smuggle a second key) and
 * length-capped. Shared by the cert-signing and key-registration contracts so
 * the 400-not-500 guarantee is identical on every path that takes a public key. */
const sshPublicKeyField = z
  .string()
  .min(1)
  .max(SSH_PUBLIC_KEY_MAX, "publicKey is too large")
  .refine((s) => SSH_PUBLIC_KEY_RE.test(s.trim()), "publicKey is not a valid OpenSSH public key");

/** POST /api/ssh-keys — register an account-level SSH public key. `label` is an
 * optional human name (e.g. "laptop"), trimmed and length-capped. */
export const registerSshKeyRequest = z.object({
  publicKey: sshPublicKeyField,
  label: z.string().trim().max(100, "label is too long").optional(),
});
export type RegisterSshKeyRequest = z.infer<typeof registerSshKeyRequest>;

/** A registered SSH key as returned to its owner. The private key never reaches
 * the server; the full public key is echoed back for display/diffing. */
export const sshKeyDto = z.object({
  id: z.string(),
  /** Human label (defaults to the key comment or type+fingerprint). */
  label: z.string(),
  /** Algorithm field, e.g. "ssh-ed25519". */
  keyType: z.string(),
  /** OpenSSH SHA256 fingerprint, e.g. "SHA256:…". */
  fingerprint: z.string(),
  publicKey: z.string(),
  createdAt: z.iso.datetime(),
});
export type SshKeyDto = z.infer<typeof sshKeyDto>;

/** POST /api/ssh-keys — response body (the created key). */
export const registerSshKeyResponse = z.object({ key: sshKeyDto });
export type RegisterSshKeyResponse = z.infer<typeof registerSshKeyResponse>;

/** GET /api/ssh-keys — response body (the caller's keys). */
export const listSshKeysResponse = z.object({ keys: z.array(sshKeyDto) });
export type ListSshKeysResponse = z.infer<typeof listSshKeysResponse>;

/** DELETE /api/ssh-keys/:id — response body. */
export const deleteSshKeyResponse = z.object({ ok: z.literal(true) });
export type DeleteSshKeyResponse = z.infer<typeof deleteSshKeyResponse>;

/** POST /api/workspaces/:id/ssh-authorize — the SSH gateway's connect-time
 * decision: does the presented public key belong to a user who owns this
 * workspace? Gateway machine-auth only (no session). The gateway's
 * `AuthorizedKeysCommand` calls this with the key the connecting client offered. */
export const sshAuthorizeRequest = z.object({ publicKey: sshPublicKeyField });
export type SshAuthorizeRequest = z.infer<typeof sshAuthorizeRequest>;

/** POST /api/workspaces/:id/ssh-authorize — response body. `authorized` gates the
 * connection; `principal` (present only when authorized) is the OS principal the
 * gateway connects as. */
export const sshAuthorizeResponse = z.object({
  authorized: z.boolean(),
  principal: z.string().optional(),
});
export type SshAuthorizeResponse = z.infer<typeof sshAuthorizeResponse>;

/** GET /api/workspaces/:id/connect-info — response body. */
export const sshConnectInfo = z.object({
  /** Private IPv4 of the workspace task's ENI (routable within the VPC). Non-empty —
   * the route returns 409 before this, but an empty host is non-representable here too. */
  host: z.string().min(1),
  /** SSH port on the workspace container (always 22 in production). */
  port: z.number().int().min(1).max(65535),
});
export type SshConnectInfo = z.infer<typeof sshConnectInfo>;

/** GET /api/workspaces/:id/git-credential — the agent-only HMAC-authed body the
 * in-workspace git credential helper consumes. A wire-identical
 * `x-access-token` + bearer pair (user-OAuth token or a GitHub App installation
 * token). The 404 `{ error: "no credential" }` path uses {@link errorResponse}. */
export const gitCredentialResponse = z.object({
  username: z.string().min(1),
  token: z.string().min(1),
});
export type GitCredentialResponse = z.infer<typeof gitCredentialResponse>;

// ---- Image builds & registry metadata (admin Images console) ----------------

/** One layer of a container image, with its (compressed) size in the registry. */
export const imageLayer = z.object({
  digest: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type ImageLayerDto = z.infer<typeof imageLayer>;

/** Registry metadata for one image tag: total compressed size, layer breakdown,
 * architecture, and when it was pushed. Sizes are the COMPRESSED sizes ECR reports
 * (what's stored/pulled); uncompressed size is not exposed by the registry API. */
export const imageMetadata = z.object({
  repo: z.string().min(1),
  tag: z.string().min(1),
  digest: z.string().min(1),
  /** Total compressed image size (sum of layer + config blob sizes). */
  compressedBytes: z.number().int().nonnegative(),
  layerCount: z.number().int().nonnegative(),
  layers: z.array(imageLayer),
  architecture: z.string().optional(),
  pushedAt: z.iso.datetime().optional(),
});
export type ImageMetadataDto = z.infer<typeof imageMetadata>;

/** Which images a build produces (mirrors EDD_BUILD_TARGET). */
export const buildTarget = z.enum(["web", "golden", "all"]);
export type BuildTargetDto = z.infer<typeof buildTarget>;

/** Lifecycle status of a build (mirrors CodeBuild build statuses). */
export const buildStatus = z.enum([
  "in_progress",
  "succeeded",
  "failed",
  "faulted",
  "timed_out",
  "stopped",
]);
export type BuildStatusDto = z.infer<typeof buildStatus>;

/** One entry in an image's build history (last N kept per image). */
export const imageBuildRecord = z.object({
  buildId: z.string().min(1),
  target: buildTarget,
  tag: z.string().min(1),
  ref: z.string().optional(),
  sourceVersion: z.string().optional(),
  status: buildStatus,
  /** Current/last CodeBuild phase (e.g. BUILD, COMPLETED). */
  phase: z.string().optional(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  triggeredBy: z.string().min(1),
});
export type ImageBuildRecordDto = z.infer<typeof imageBuildRecord>;

export const imageSourceTriggerStatus = z.enum([
  "received",
  "skipped",
  "queued",
  "building",
  "succeeded",
  "failed",
]);
export type ImageSourceTriggerStatusDto = z.infer<typeof imageSourceTriggerStatus>;

export const imageSourceTriggerDecision = z.enum(["build", "skip"]);
export type ImageSourceTriggerDecisionDto = z.infer<typeof imageSourceTriggerDecision>;

export const imageSourceTrigger = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  beforeSha: z.string().optional(),
  afterSha: z.string().min(1),
  changedPaths: z.array(z.string()),
  decision: imageSourceTriggerDecision,
  reason: z.string().min(1),
  status: imageSourceTriggerStatus,
  target: buildTarget.optional(),
  tag: z.string().optional(),
  sourceVersion: z.string().optional(),
  buildId: z.string().optional(),
  triggeredBy: z.string().min(1),
  receivedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ImageSourceTriggerDto = z.infer<typeof imageSourceTrigger>;

export const imageSourceState = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  lastObservedSha: z.string().optional(),
  lastHandledSha: z.string().optional(),
  latestTriggerId: z.string().optional(),
  updatedAt: z.iso.datetime().optional(),
  triggers: z.array(imageSourceTrigger),
});
export type ImageSourceStateDto = z.infer<typeof imageSourceState>;

/** A slice of a build's live log, plus a cursor to fetch the next slice. */
export const buildLogChunk = z.object({
  lines: z.array(z.object({ at: z.iso.datetime(), message: z.string() })),
  /** Opaque cursor for the next poll; absent when the stream has no more (yet). */
  nextToken: z.string().optional(),
});
export type BuildLogChunkDto = z.infer<typeof buildLogChunk>;

// ── Admin traffic filter (IP / country / ASN / cloud-hoster presets / anonymous) ──
// Mirrors @edd/core's TrafficFilterPolicy; the control plane compiles it into WAFv2
// rules and applies them to the CLOUDFRONT-scope Web ACL.
export const filterMode = z.enum(["allow", "block"]);
export type FilterModeDto = z.infer<typeof filterMode>;

export const trafficFilterPolicy = z.object({
  version: z.literal(1),
  mode: filterMode,
  cidrs: z.array(z.string().min(1)),
  countries: z.array(z.string().length(2)),
  asns: z.array(z.number().int().positive()),
  presets: z.array(z.string().min(1)),
  blockAnonymous: z.boolean(),
});
export type TrafficFilterPolicyDto = z.infer<typeof trafficFilterPolicy>;

/** One compiled WAF rule, previewed to the admin before/after apply. */
export const compiledFilterRule = z.object({
  kind: z.enum(["ip", "geo", "asn", "managed-anonymous"]),
  action: z.enum(["allow", "block"]),
  detail: z.string(),
});
export type CompiledFilterRuleDto = z.infer<typeof compiledFilterRule>;

/** GET /api/admin/traffic — the current policy, the compiled rule preview, the
 * available presets, and whether the last apply to the live WAF succeeded. */
export const trafficFilterState = z.object({
  policy: trafficFilterPolicy,
  defaultAction: z.enum(["allow", "block"]),
  compiled: z.array(compiledFilterRule),
  presets: z.array(z.string().min(1)),
  appliedAt: z.iso.datetime().optional(),
  appliedError: z.string().optional(),
});
export type TrafficFilterStateDto = z.infer<typeof trafficFilterState>;

// PUT /api/admin/traffic replaces the policy (and applies it to the live WAF); its
// request body is exactly a `trafficFilterPolicy`, so callers parse with that schema.
