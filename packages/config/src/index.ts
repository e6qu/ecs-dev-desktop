// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Role } from "@edd/authz";
import { z } from "zod";

/**
 * Typed configuration. Endpoints, ports, and default values live here (and in
 * per-module configs) — type-checked, never hardcoded in feature code.
 */

export const DEFAULT_AWS_REGION = "us-east-1";
export const DEFAULT_DYNAMODB_TABLE = "ecs-dev-desktop";
export const COST_SCOPE_TAG_KEY = "edd:cost-scope";
export const DEFAULT_COST_SCOPE = "edd-alpha";

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
/** GitHub web/OAuth base. Override (env, `AUTH_GITHUB_URL`) points at GitHub
 * Enterprise or a local harness; default is public GitHub. */
export const DEFAULT_GITHUB_URL = "https://github.com";

/** ECS Fargate workspace-runtime defaults (cluster / subnets / role are
 * deployment-specific and supplied by config, not defaulted). */
export const DEFAULT_ECS_CLUSTER = "edd-workspaces";
export const DEFAULT_WORKSPACE_CONTAINER = "workspace";
/** `awslogs-stream-prefix` for workspace tasks. The ECS awslogs driver names each
 * task's CloudWatch stream `<prefix>/<containerName>/<taskId>`; the admin Logs view
 * uses this to filter the shared workspaces log group to one workspace. */
export const DEFAULT_WORKSPACE_LOG_STREAM_PREFIX = "workspace";
/**
 * EBS volume mount path inside the workspace container — the persisted root. It is deliberately
 * NOT the user's home/pwd: the user works in {@link DEFAULT_WORKSPACE_PROJECT_PATH} (a clean,
 * empty-when-fresh subdir), while editor/tool state lives under {@link DEFAULT_WORKSPACE_HOME_PATH}
 * (HOME) and OpenVSCode extensions under {@link DEFAULT_WORKSPACE_EXTENSIONS_PATH} — all persisted
 * on this volume but OUT of the project dir, so an empty workspace's pwd stays empty. The editor
 * software itself is read-only under /opt + /usr/local (baked at image build). These path literals
 * are mirrored in the workspace image (Dockerfile/entrypoint.sh) — keep them in sync.
 */
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/data";
/** The user's project directory: pwd, shell cwd, and the editor's opened folder. Clean/empty for a
 * fresh workspace (a cloned repo lands in a subdir); persisted under the mount. */
export const DEFAULT_WORKSPACE_PROJECT_PATH = "/data/project";
/** The workspace user's HOME — editor/tool config, state, caches, shell history — persisted but
 * OUTSIDE the project pwd so it never pollutes the user's working directory. */
export const DEFAULT_WORKSPACE_HOME_PATH = "/data/home";
/** Writable, persisted OpenVSCode user-extensions directory — the one editor-state dir the user
 * mutates (installs), kept out of the project pwd. */
export const DEFAULT_WORKSPACE_EXTENSIONS_PATH = "/data/extensions";
/** Port OpenVSCode Server listens on inside the workspace container. */
export const DEFAULT_WORKSPACE_PORT = 3000;
/** How often the idle-agent POSTs /heartbeat (seconds). 2 minutes: fires within
 * every 5-minute reconciler window; 15× within the 30-minute idle threshold. */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 120;

const DYNAMODB_HOST = "127.0.0.1";
// The sockerless sim serves DynamoDB on the same unified endpoint as the rest of the
// AWS API (:4566) — used by CI, integration tests, and the local dev loop alike.
// Real cloud is reached by the SDK's standard resolution / `DYNAMODB_ENDPOINT`.
const DYNAMODB_PORT = 4566;

/** DynamoDB endpoint coordinate. Defaults to the local sim (`:4566`); overridden by
 * `DYNAMODB_ENDPOINT` (e.g. `host.docker.internal:4566` for in-container access). */
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
 * Base domain under which a running workspace is reachable over SSH as
 * `<ws-id>.<baseDomain>` through the SSH gateway. Empty (the default) until a
 * deployment provisions the public SSH ingress + wildcard DNS (Phase 4b); the
 * portal surfaces each workspace's `ssh` command only when this is set, so it
 * never advertises an address that does not resolve. Real deployments set
 * `EDD_SSH_BASE_DOMAIN` (e.g. `ssh.example.com`). Base-domain-only config (§6.8).
 */
export const SSH_BASE_DOMAIN = process.env.EDD_SSH_BASE_DOMAIN ?? "";

/** Cost-allocation grouping tag value for this EDD environment. AWS Cost
 * Explorer groups by tag key, so every environment uses the same key
 * (`edd:cost-scope`) and a distinct value (default: `edd-alpha`). */
export const COST_SCOPE =
  process.env.EDD_COST_SCOPE === undefined || process.env.EDD_COST_SCOPE.length === 0
    ? DEFAULT_COST_SCOPE
    : z.string().min(1).parse(process.env.EDD_COST_SCOPE);

/**
 * Whether the AWS account-cost summary scopes Cost Explorer to the `edd:cost-scope`
 * tag ({@link COST_SCOPE}). Default **false** — report the WHOLE account's usage.
 *
 * Load-bearing default: tag scoping only works when `edd:cost-scope` has been ACTIVATED
 * as a cost-allocation tag in AWS Billing (a manual, non-retroactive step) AND every
 * cost-driving resource carries the tag on its billing usage record (some — e.g. data
 * transfer/egress, and Fargate tasks whose service doesn't propagate tags — never do).
 * When either is missing, a tag-filtered query returns **$0** even though the account is
 * spending real money, which silently under-reports the bill. So EDD defaults to the
 * honest whole-account view (correct for a dedicated EDD account) and only scopes by tag
 * when an operator opts in for a SHARED account via `EDD_COST_SCOPE_ENABLED=1` — having
 * first activated the cost-allocation tag and confirmed tag coverage. */
export const COST_SCOPE_ENABLED = process.env.EDD_COST_SCOPE_ENABLED === "1";

/** Deploy provenance baked into the control-plane image at build time (see
 * apps/web/Dockerfile + publish-images.sh): the short git sha it was built from and
 * the UTC build timestamp (ISO-8601). Empty strings in a plain local/dev build. The
 * app footer surfaces these so operators can see which build is live and how old. */
export const DEPLOY_SHA = process.env.EDD_BUILD_SHA ?? "";
export const DEPLOY_TIME = process.env.EDD_BUILD_TIME ?? "";

/** How stale the cost-rollup checkpoints may get before the reconciler regenerates them.
 * Bounds the report's replay tail (so a cost read stays O(recent) instead of full-scanning
 * the whole append-only ledger) without pricing the entire ledger every single sweep. */
export const COST_ROLLUP_CADENCE_MS = 15 * 60 * 1000;

/** Max ms the in-app workspace proxy waits for the workspace upstream to respond/upgrade
 * before tearing down — a just-woken editor that accepts the connection but never serves
 * must not leave the client socket hung open indefinitely. */
export const WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS = 30000;

/** Max bytes the proxy buffers when it must rewrite an editor response body (HTML shell
 * / opencode asset). Only rewritable content types are buffered at all, but the buffer is
 * still fully in-memory, so an oversized (or maliciously large) upstream body could
 * exhaust the control plane's heap. A rewritable editor document is small in practice;
 * this generous ceiling bounds memory and makes an over-cap body fail loudly (502) instead
 * of OOM-ing the shared control plane. */
export const WORKSPACE_PROXY_MAX_REWRITE_BYTES = 16 * 1024 * 1024;

/** How often the server converges workspaces in the cancelable `stopping` state to
 * `stopped` (finishStop is grace-honoring + idempotent, so a tight tick is safe).
 * Convergence lands within ~DEFAULT_STOP_GRACE_MS + this interval. */
export const STOPPING_SWEEP_MS = 3000;

/** How often the long-lived control-plane process reconciles EDD-owned workspace
 * image-source builds against CodeBuild. This makes successful golden builds roll
 * into the base-image catalog without requiring an admin to have `/admin/images`
 * open. */
export const IMAGE_SOURCE_RECONCILE_SWEEP_MS = 60_000;

/**
 * Cost model rates (USD), as published for **us-east-1 on-demand** at the time
 * of writing — each overridable via the matching `EDD_PRICE_*` env var so a
 * deployment can match its own region / account pricing without a code change.
 * Sources: AWS Fargate pricing (per-vCPU-hour, per-GB-hour) and AWS EBS pricing
 * (gp3 storage, snapshot storage), all us-east-1.
 *
 * Region note (verified against the AWS Price List API): eu-west-1 Fargate vCPU/GB-hour
 * and EBS snapshot match these us-east-1 rates exactly; only **EBS gp3 storage** differs
 * ($0.088 vs $0.080/GB-mo). The eu-west-1 prod deployment sets `EDD_PRICE_EBS_GB_MONTH`
 * accordingly (see `examples/complete/install.tfvars`). These rates only drive the derived
 * per-workspace attribution estimate; the authoritative bill is Cost Explorer (whole-account).
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

/** A positive number from `name`, or `fallback` when unset; fails loud on a
 * non-numeric / non-positive value rather than silently mis-sizing. */
function positiveNumEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number: ${raw}`);
  }
  return value;
}

/**
 * The control plane's own Fargate task sizing, for the cost run-rate projection ("$/hr if all
 * running"). Defaults match the Terraform module (`control_plane_cpu=512` CPU units → 0.5 vCPU,
 * `control_plane_memory=1024` MiB → 1 GiB, `control_plane_desired_count=2`); override via env to
 * match a customized deployment (e.g. set these in `extra_environment` alongside the tf vars).
 */
export function controlPlaneSizing(): { vcpu: number; memoryGib: number; replicas: number } {
  return {
    vcpu: positiveNumEnv("EDD_CONTROL_PLANE_CPU_UNITS", 512) / 1024,
    memoryGib: positiveNumEnv("EDD_CONTROL_PLANE_MEMORY_MIB", 1024) / 1024,
    replicas: positiveNumEnv("EDD_CONTROL_PLANE_ACTIVE_DESIRED", 2),
  };
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

/**
 * Local **dev-auth** seeded accounts (gated on `EDD_DEV_AUTH=1` in the app — never
 * production, which uses Auth.js OIDC). Configuration, not app code: the set is
 * overridable via `EDD_DEV_USERS` (a JSON array). A built-in default keeps
 * `pnpm dev` working out of the box. Each account has a fixed role and password.
 */
export interface DevUser {
  readonly username: string;
  readonly role: Role;
  readonly email: string;
  readonly password: string;
}

const devUserSchema = z.object({
  username: z.string().min(1),
  role: z.enum(["viewer", "developer", "admin"]),
  email: z.string().min(1),
  password: z.string().min(1),
});
const devUsersSchema = z.array(devUserSchema).min(1);

const DEFAULT_DEV_USERS: readonly DevUser[] = [
  { username: "admin", role: "admin", email: "admin@edd.local", password: "dev" },
  { username: "developer", role: "developer", email: "developer@edd.local", password: "dev" },
  { username: "viewer", role: "viewer", email: "viewer@edd.local", password: "dev" },
];

/** The seeded dev accounts: `EDD_DEV_USERS` (JSON) if set, else the default set.
 * An invalid `EDD_DEV_USERS` fails loudly (zod) — a config error, not silent. */
export function devUsers(): readonly DevUser[] {
  const raw = process.env.EDD_DEV_USERS;
  if (raw === undefined || raw.length === 0) return DEFAULT_DEV_USERS;
  return devUsersSchema.parse(JSON.parse(raw) as unknown);
}

/**
 * Default per-role cap on the number of workspaces a user may own (`null` =
 * unlimited). Overridable per role via `EDD_QUOTA_<ROLE>` (e.g. `EDD_QUOTA_DEVELOPER=10`).
 * Keyed by `Role` (not `string`): every role must have a quota, and a typo'd or
 * removed role is a compile error.
 */
export const DEFAULT_WORKSPACE_QUOTAS: Record<Role, number | null> = {
  viewer: 0,
  developer: 5,
  admin: null,
};
/** Env var prefix for a per-role quota override: `EDD_QUOTA_DEVELOPER`, etc. */
export const QUOTA_ENV_PREFIX = "EDD_QUOTA_";

/**
 * Runtime environment schema. Components parse `process.env` through this so
 * misconfiguration fails fast at startup rather than at first use.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AWS_REGION: z.string().min(1).default(DEFAULT_AWS_REGION),
  DYNAMODB_TABLE: z.string().min(1).default(DEFAULT_DYNAMODB_TABLE),
  EDD_COST_SCOPE: z.string().min(1).default(DEFAULT_COST_SCOPE),
  // "1" scopes the AWS account-cost summary to the edd:cost-scope tag (shared-account
  // mode); default (whole account) reports the real bill without a tag filter.
  EDD_COST_SCOPE_ENABLED: z.string().optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): BaseEnv {
  return baseEnvSchema.parse(env);
}
