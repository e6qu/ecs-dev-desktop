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
  "terminated",
  "error",
]);
export type WorkspaceStateDto = z.infer<typeof workspaceState>;

export const workspace = z.object({
  id: z.string(),
  ownerId: z.string(),
  baseImage: z.string(),
  state: workspaceState,
  createdAt: z.iso.datetime(),
});
export type WorkspaceDto = z.infer<typeof workspace>;

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
   * per-workspace access. Absent on records created without a session email. */
  ownerEmail: z.string().optional(),
  /** Git repo cloned into the session, if any ("one repo per session"). */
  repoUrl: z.string().optional(),
  baseImage: z.string(),
  state: workspaceState,
  createdAt: z.iso.datetime(),
  lastActivity: z.iso.datetime(),
  volumeId: z.string().optional(),
  taskId: z.string().optional(),
  latestSnapshotId: z.string().optional(),
  latestSnapshotAt: z.iso.datetime().optional(),
  /** Private IP of the running task's ENI; absent when stopped/scaled-to-zero. */
  sshHost: z.string().optional(),
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
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type BaseImageEntryDto = z.infer<typeof baseImageEntry>;

export const createBaseImageRequest = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type CreateBaseImageRequest = z.infer<typeof createBaseImageRequest>;

/** Partial update; the id and image ref are immutable. At least one field. */
export const updateBaseImageRequest = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((p) => p.name !== undefined || p.description !== undefined || p.enabled !== undefined, {
    message: "at least one field is required",
  });
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

/** POST /api/workspaces/:id/ssh-cert — request body. */
export const sshCertRequest = z.object({
  /** User's SSH public key in OpenSSH authorized_keys format (e.g. "ssh-ed25519 AAAA... comment").
   * One line, known key type, base64 blob — no newlines (so it can't smuggle a
   * second key) and length-capped. */
  publicKey: z
    .string()
    .min(1)
    .max(SSH_PUBLIC_KEY_MAX, "publicKey is too large")
    .refine((s) => SSH_PUBLIC_KEY_RE.test(s.trim()), "publicKey is not a valid OpenSSH public key"),
});
export type SshCertRequest = z.infer<typeof sshCertRequest>;

/** POST /api/workspaces/:id/ssh-cert — response body. */
export const sshCertResponse = z.object({
  /** Signed OpenSSH certificate ready to write to ~/.ssh/id_*-cert.pub. */
  cert: z.string(),
});
export type SshCertResponse = z.infer<typeof sshCertResponse>;

/** GET /api/workspaces/:id/connect-info — response body. */
export const sshConnectInfo = z.object({
  /** Private IP of the workspace task's ENI (routable within the VPC). */
  host: z.string(),
  /** SSH port on the workspace container (always 22 in production). */
  port: z.number().int().min(1).max(65535),
});
export type SshConnectInfo = z.infer<typeof sshConnectInfo>;
