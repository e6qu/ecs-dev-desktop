// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Role } from "@edd/authz";
import { z } from "zod";

/**
 * Typed configuration. Endpoints, ports, and default values live here (and in
 * per-module configs) — type-checked, never hardcoded in feature code.
 */

export const DEFAULT_AWS_REGION = "us-east-1";
export const DEFAULT_DYNAMODB_TABLE = "ecs-dev-desktop";

/**
 * AWS SDK retry tuning for the control-plane clients. ECS mutating calls
 * (notably `RunTask`) are throttle-prone in real AWS, and concurrent
 * wake-on-connect bursts fire several `RunTask`s at once. The SDK default
 * (`standard`, 3 attempts) can exhaust under that burst and surface a transient
 * 5xx/throttle as a hard failure. `adaptive` mode adds a client-side rate
 * limiter (it backs off the whole client when throttled) and a higher attempt
 * ceiling absorbs the burst. Endpoint-agnostic — correct against real AWS, not a
 * simulator workaround (§6.8). */
export const AWS_SDK_MAX_ATTEMPTS = 6;
export const AWS_SDK_RETRY_MODE = "adaptive" as const;

/** GitHub REST API base. Override (env, `AUTH_GITHUB_API_URL`) points at GitHub
 * Enterprise or a local harness `/api/v3`; default is public GitHub. */
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

/** ECS Fargate workspace-runtime defaults (cluster / subnets / role are
 * deployment-specific and supplied by config, not defaulted). */
export const DEFAULT_ECS_CLUSTER = "edd-workspaces";
export const DEFAULT_WORKSPACE_CONTAINER = "workspace";
/** `awslogs-stream-prefix` for workspace tasks. The ECS awslogs driver names each
 * task's CloudWatch stream `<prefix>/<containerName>/<taskId>`; the admin Logs view
 * uses this to filter the shared workspaces log group to one workspace. */
export const DEFAULT_WORKSPACE_LOG_STREAM_PREFIX = "workspace";
/** EBS volume mount path inside the workspace container (= workspace user home). */
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/home/workspace";
export const DEFAULT_WORKSPACE_VOLUME_GIB = 8;
export const DEFAULT_WORKSPACE_CPU = "512";
export const DEFAULT_WORKSPACE_MEMORY = "1024";
/** Port OpenVSCode Server listens on inside the workspace container. */
export const DEFAULT_WORKSPACE_PORT = 3000;
/** How often the idle-agent POSTs /heartbeat (seconds). 2 minutes: fires within
 * every 5-minute reconciler window; 15× within the 30-minute idle threshold. */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 120;

const DYNAMODB_HOST = "127.0.0.1";
const DYNAMODB_PORT = 8000;

/** DynamoDB endpoint coordinate. The default is the local harness; real cloud is
 * reached by the SDK's standard endpoint resolution / `DYNAMODB_ENDPOINT`. */
export const dynamodb = {
  host: DYNAMODB_HOST,
  port: DYNAMODB_PORT,
  endpoint: `http://${DYNAMODB_HOST}:${DYNAMODB_PORT}`,
} as const;

/**
 * Scheme for the local harness endpoint defaults below. Defaults to plain HTTP;
 * `EDD_SIM_SCHEME=https` drives the local harness over TLS (the HTTPS e2e harness
 * mounts a self-signed cert and the client trusts its CA via `NODE_EXTRA_CA_CERTS`).
 * Coordinate-only (§6.9): real-cloud URLs are HTTPS regardless; this only flips the
 * local defaults. Unset → `http`; an invalid explicit value throws (loud).
 */
const LOCAL_SCHEME: "http" | "https" =
  process.env.EDD_SIM_SCHEME === undefined
    ? "http"
    : z.enum(["http", "https"]).parse(process.env.EDD_SIM_SCHEME);

const AWS_HOST = "127.0.0.1";
const AWS_PORT = 4566;

/**
 * AWS API endpoint coordinate. The default is the local harness (one endpoint
 * serving the AWS API surface — EC2/EBS, DynamoDB, ECS, …); real cloud is reached
 * by the SDK's standard resolution / `AWS_ENDPOINT_URL`. Coordinate-only (§6.9).
 */
export const aws = {
  host: AWS_HOST,
  port: AWS_PORT,
  endpoint: `${LOCAL_SCHEME}://${AWS_HOST}:${AWS_PORT}`,
} as const;

const GITHUB_HOST = "127.0.0.1";
const GITHUB_PORT = 5555;

/** GitHub endpoint coordinate: `url` is the OAuth web root (`/login/oauth/*`),
 * `apiUrl` the REST base (`/api/v3`). The default is the local harness; real
 * GitHub / GHES is reached via `AUTH_GITHUB_URL` / `AUTH_GITHUB_API_URL`. */
export const github = {
  url: `${LOCAL_SCHEME}://${GITHUB_HOST}:${GITHUB_PORT}`,
  apiUrl: `${LOCAL_SCHEME}://${GITHUB_HOST}:${GITHUB_PORT}/api/v3`,
} as const;

const ENTRA_HOST = "127.0.0.1";
const ENTRA_PORT = 4568;
/** Entra tenant the harness drives. Real Entra reads the tenant from the request
 * path, so any stable value works (no behaviour depends on it). */
export const ENTRA_TENANT = "edd-e2e-tenant";

/** Entra / OIDC endpoint coordinate. `authority` is the OIDC issuer root
 * (`/{tenant}/oauth2/v2.0/*`); `graphUrl` the Microsoft Graph base. The default is
 * the local harness; real cloud points at `login.microsoftonline.com` /
 * `graph.microsoft.com` — same code, coordinate-only (§6.9). */
export const entra = {
  endpoint: `${LOCAL_SCHEME}://${ENTRA_HOST}:${ENTRA_PORT}`,
  authority: `${LOCAL_SCHEME}://${ENTRA_HOST}:${ENTRA_PORT}/${ENTRA_TENANT}`,
  graphUrl: `${LOCAL_SCHEME}://${ENTRA_HOST}:${ENTRA_PORT}/v1.0`,
} as const;

/**
 * Base domain under which every workspace is reached as
 * `<ws-id>.<baseDomain>` through the identity-aware proxy. The harness default
 * is `devbox.localhost`; real deployments set `EDD_WORKSPACE_BASE_DOMAIN`
 * (e.g. `devbox.example.com`). Endpoint/base-domain-only config (§6.8).
 */
export const WORKSPACE_BASE_DOMAIN = process.env.EDD_WORKSPACE_BASE_DOMAIN ?? "devbox.localhost";

/** Control-plane path the workspace gate (PEP) consults for a per-request
 * access decision (PDP). Mounted under the Next.js app router. */
export const WORKSPACE_AUTHZ_PATH = "/api/internal/authz";

/** Header the gate uses to tell the PDP which workspace host it is fronting
 * (the PDP also requires the proxy JWT's `aud` to equal this host). */
export const WORKSPACE_HOST_HEADER = "x-edd-workspace-host";

/** Pomerium signs the identity assertion injected as this header; the PDP
 * verifies it against Pomerium's JWKS. Lowercase per the HTTP/2 convention the
 * proxy emits. */
export const POMERIUM_ASSERTION_HEADER = "x-pomerium-jwt-assertion";

const WORKSPACE_GATE_PORT = 8080;

/** Env var holding Pomerium's JWKS URL the PDP verifies assertions against. Read
 * at verification time (not module load) so a test can point it at a dynamically
 * bound JWKS server, and production injects the real proxy URL. */
export const POMERIUM_JWKS_URL_ENV = "EDD_POMERIUM_JWKS_URL";

/**
 * Workspace authorization gate (PEP) wiring. `port` is where the thin gate
 * listens; `pdpUrl` is the control-plane decision endpoint it consults;
 * `upstreamUrl` is a STATIC workspace target (single-workspace/tests);
 * `controlPlaneUrl` is the control-plane base the gate calls to wake + resolve a
 * workspace's live address (dynamic per-workspace routing). All overridable via
 * env so the same code runs in the harness and real cloud.
 */
export const workspaceGate = {
  port: WORKSPACE_GATE_PORT,
  pdpUrl: process.env.EDD_WORKSPACE_PDP_URL ?? `http://127.0.0.1:3000${WORKSPACE_AUTHZ_PATH}`,
  upstreamUrl: process.env.EDD_WORKSPACE_UPSTREAM_URL,
  controlPlaneUrl: process.env.EDD_CONTROL_PLANE_URL,
} as const;

/** Env var holding the gate's machine-auth secret (hex) — used to derive the
 * per-workspace HMAC token for the control-plane wake/connect-info calls. */
export const GATEWAY_SECRET_ENV = "EDD_GATEWAY_SECRET";

/**
 * Cost model rates (USD), as published for **us-east-1 on-demand** at the time
 * of writing — each overridable via the matching `EDD_PRICE_*` env var so a
 * deployment can match its own region / account pricing without a code change.
 * Sources: AWS Fargate pricing (per-vCPU-hour, per-GB-hour) and AWS EBS pricing
 * (gp3 storage, snapshot storage), all us-east-1.
 */
export const DEFAULT_FARGATE_VCPU_HOUR_USD = 0.04048;
export const DEFAULT_FARGATE_GB_HOUR_USD = 0.004445;
export const DEFAULT_EBS_GB_MONTH_USD = 0.08;
export const DEFAULT_EBS_SNAPSHOT_GB_MONTH_USD = 0.05;

/** A non-negative USD rate from `name`, or `fallback` when unset. Invalid
 * (non-numeric / negative) values fail loudly rather than silently mispricing. */
function priceEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative USD rate: ${raw}`);
  }
  return value;
}

/** The cost-model rates in effect (defaults above, each `EDD_PRICE_*`-overridable). */
export function workspacePricing(): {
  fargateVcpuHourUsd: number;
  fargateGbHourUsd: number;
  ebsGbMonthUsd: number;
  snapshotGbMonthUsd: number;
} {
  return {
    fargateVcpuHourUsd: priceEnv("EDD_PRICE_FARGATE_VCPU_HOUR", DEFAULT_FARGATE_VCPU_HOUR_USD),
    fargateGbHourUsd: priceEnv("EDD_PRICE_FARGATE_GB_HOUR", DEFAULT_FARGATE_GB_HOUR_USD),
    ebsGbMonthUsd: priceEnv("EDD_PRICE_EBS_GB_MONTH", DEFAULT_EBS_GB_MONTH_USD),
    snapshotGbMonthUsd: priceEnv("EDD_PRICE_SNAPSHOT_GB_MONTH", DEFAULT_EBS_SNAPSHOT_GB_MONTH_USD),
  };
}

/** ECS CPU units that make up one vCPU (1024 = 1 vCPU; AWS task-size convention). */
const CPU_UNITS_PER_VCPU = 1024;
/** MiB per GiB (memory is configured in MiB; the cost model bills per GiB). */
const MIB_PER_GIB = 1024;

/** The per-workspace sizing the cost model multiplies by run-time. Reads the
 * SAME env overrides the ECS compute provider provisions from (`ECS_TASK_CPU` /
 * `ECS_TASK_MEMORY` / `ECS_VOLUME_GIB`), so billed sizing tracks real sizing. */
export function workspaceSizing(): { vcpu: number; memoryGib: number; volumeGib: number } {
  const cpuUnits = Number(process.env.ECS_TASK_CPU ?? DEFAULT_WORKSPACE_CPU);
  const memoryMib = Number(process.env.ECS_TASK_MEMORY ?? DEFAULT_WORKSPACE_MEMORY);
  const volumeGib = Number(process.env.ECS_VOLUME_GIB ?? DEFAULT_WORKSPACE_VOLUME_GIB);
  if (![cpuUnits, memoryMib, volumeGib].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error(
      "workspace sizing (ECS_TASK_CPU/ECS_TASK_MEMORY/ECS_VOLUME_GIB) must be positive",
    );
  }
  return { vcpu: cpuUnits / CPU_UNITS_PER_VCPU, memoryGib: memoryMib / MIB_PER_GIB, volumeGib };
}

/**
 * Local **dev-auth** seeded accounts (gated on `EDD_DEV_AUTH=1` in the app — never
 * production, which uses Auth.js OIDC). Configuration, not app code: the set is
 * overridable via `EDD_DEV_USERS` (a JSON array). A built-in default keeps
 * `pnpm dev` working out of the box. Each account has a fixed role; the password
 * is per-user (`password`) or the shared `EDD_DEV_PASSWORD` fallback.
 */
export interface DevUser {
  readonly username: string;
  readonly role: Role;
  readonly email: string;
  /** Optional per-user password; falls back to {@link devPassword}. */
  readonly password?: string;
}

const devUserSchema = z.object({
  username: z.string().min(1),
  role: z.enum(["viewer", "member", "admin"]),
  email: z.string().min(1),
  password: z.string().min(1).optional(),
});
const devUsersSchema = z.array(devUserSchema).min(1);

const DEFAULT_DEV_USERS: readonly DevUser[] = [
  { username: "admin", role: "admin", email: "admin@edd.local" },
  { username: "member", role: "member", email: "member@edd.local" },
  { username: "viewer", role: "viewer", email: "viewer@edd.local" },
];

/** Dev password fallback when an account has none and `EDD_DEV_PASSWORD` is unset. */
export const DEFAULT_DEV_PASSWORD = "dev";

/** The seeded dev accounts: `EDD_DEV_USERS` (JSON) if set, else the default set.
 * An invalid `EDD_DEV_USERS` fails loudly (zod) — a config error, not silent. */
export function devUsers(): readonly DevUser[] {
  const raw = process.env.EDD_DEV_USERS;
  if (raw === undefined || raw.length === 0) return DEFAULT_DEV_USERS;
  return devUsersSchema.parse(JSON.parse(raw) as unknown);
}

/** The shared dev password (per-account passwords override it). */
export function devPassword(): string {
  const p = process.env.EDD_DEV_PASSWORD;
  return p === undefined || p.length === 0 ? DEFAULT_DEV_PASSWORD : p;
}

/**
 * Default per-role cap on the number of workspaces a user may own (`null` =
 * unlimited). Overridable per role via `EDD_QUOTA_<ROLE>` (e.g. `EDD_QUOTA_MEMBER=10`).
 * Keyed by `Role` (not `string`): every role must have a quota, and a typo'd or
 * removed role is a compile error.
 */
export const DEFAULT_WORKSPACE_QUOTAS: Record<Role, number | null> = {
  viewer: 0,
  member: 5,
  admin: null,
};
/** Env var prefix for a per-role quota override: `EDD_QUOTA_MEMBER`, etc. */
export const QUOTA_ENV_PREFIX = "EDD_QUOTA_";

/**
 * Runtime environment schema. Components parse `process.env` through this so
 * misconfiguration fails fast at startup rather than at first use.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AWS_REGION: z.string().min(1).default(DEFAULT_AWS_REGION),
  DYNAMODB_TABLE: z.string().min(1).default(DEFAULT_DYNAMODB_TABLE),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): BaseEnv {
  return baseEnvSchema.parse(env);
}
