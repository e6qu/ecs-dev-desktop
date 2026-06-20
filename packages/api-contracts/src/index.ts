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
export const workspaceAction = z.enum(["start", "stop", "snapshot", "delete"]);
export type WorkspaceActionDto = z.infer<typeof workspaceAction>;

export const workspace = z.object({
  id: z.string(),
  ownerId: z.string(),
  baseImage: z.string(),
  state: workspaceState,
  createdAt: z.iso.datetime(),
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

/** Optional functional self-report carried on a heartbeat (in-workspace agent). */
export const heartbeatRequest = z.object({
  functional: z
    .object({
      /** OpenVSCode reachable on the workspace port. */
      ide: z.boolean(),
      /** The workspace home directory is writable. */
      workspace: z.boolean(),
    })
    .optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequest>;

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

export const createWorkspaceRequest = z.object({
  baseImage: z.string().min(1),
  /** Optional git repo to clone into the session at first boot ("one repo per
   * session"). HTTPS URL; private repos use the owner's git credential. */
  repoUrl: z.url().startsWith("https://").optional(),
  /** Optional branch/tag/SHA to check out (defaults to the repo's default). */
  repoRef: z.string().min(1).max(255).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequest>;

export const listWorkspacesResponse = z.object({
  workspaces: z.array(workspace),
});
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponse>;

// --- Admin: per-workspace Inspect (full detail + derived timeline) ---

export const workspaceDetail = z.object({
  id: z.string(),
  ownerId: z.string(),
  /** Owner's email — the identity the proxy matches a caller against for
   * per-workspace access. Absent on records created without a session email.
   * Validated as an email (not a bare string) so a malformed value is rejected at
   * the wire boundary, matching `@edd/core`'s `email()` smart constructor. */
  ownerEmail: z.email().optional(),
  /** Git repo cloned into the session, if any ("one repo per session"). */
  repoUrl: z.string().optional(),
  baseImage: z.string(),
  state: workspaceState,
  /** Durable intent: should this workspace exist (`present`) or be torn down
   * (`deleted`). Absent on records predating the field ⇒ treated `present`. */
  desiredState: desiredState.optional(),
  /** When a delete was requested (the `deleting` tombstone began), if any. */
  deleteRequestedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  lastActivity: z.iso.datetime(),
  volumeId: z.string().optional(),
  taskId: z.string().optional(),
  latestSnapshotId: z.string().optional(),
  latestSnapshotAt: z.iso.datetime().optional(),
  /** Private IP of the running task's ENI; absent when stopped/scaled-to-zero. */
  sshHost: z.string().optional(),
  /** Functional usability self-report from the in-workspace agent (is the desktop
   * actually usable, not just running): `ok` / `degraded` + detail + when. */
  functional: z.enum(["ok", "degraded"]).optional(),
  functionalDetail: z.string().optional(),
  functionalAt: z.iso.datetime().optional(),
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
  createdAt: z.iso.datetime(),
});
export type BaseImageEntryDto = z.infer<typeof baseImageEntry>;

export const createBaseImageRequest = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});
export type CreateBaseImageRequest = z.infer<typeof createBaseImageRequest>;

/** Partial update; the id and image ref are immutable. At least one field. */
export const updateBaseImageRequest = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (p) =>
      p.name !== undefined ||
      p.description !== undefined ||
      p.tags !== undefined ||
      p.tools !== undefined ||
      p.enabled !== undefined,
    {
      message: "at least one field is required",
    },
  );
export type UpdateBaseImageRequest = z.infer<typeof updateBaseImageRequest>;

export const listBaseImagesResponse = z.object({
  baseImages: z.array(baseImageEntry),
});
export type ListBaseImagesResponse = z.infer<typeof listBaseImagesResponse>;

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
});
export type AuditEventDto = z.infer<typeof auditEvent>;

export const auditFeedResponse = z.object({
  events: z.array(auditEvent),
});
export type AuditFeedResponse = z.infer<typeof auditFeedResponse>;

// --- Admin: cost report (prices the lifecycle audit ledger) ---

export const costBreakdown = z.object({
  computeUsd: z.number(),
  volumeUsd: z.number(),
  snapshotUsd: z.number(),
  totalUsd: z.number(),
  runningMs: z.number(),
  stoppedMs: z.number(),
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
  state: z.string(),
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
  sizing: costSizing,
  total: costBreakdown,
  byUser: z.array(userCost),
  bySession: z.array(sessionCost),
});
export type CostReport = z.infer<typeof costReport>;

// --- Admin: quota report (per-role limits + per-user usage) ---

export const quotaReport = z.object({
  /** Per-role workspace caps (`limit: null` = unlimited). */
  limits: z.array(z.object({ role: z.string(), limit: z.number().nullable() })),
  /** Current workspace count per owner, busiest first. */
  usage: z.array(z.object({ owner: z.string(), count: z.number().int().nonnegative() })),
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
  /** Private IP of the workspace task's ENI (routable within the VPC). */
  host: z.string(),
  /** SSH port on the workspace container (always 22 in production). */
  port: z.number().int().min(1).max(65535),
});
export type SshConnectInfo = z.infer<typeof sshConnectInfo>;
