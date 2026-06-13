// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Role } from "@edd/authz";
import { z } from "zod";

/**
 * Typed configuration. Endpoints, ports, and default values live here (and in
 * per-module configs) — type-checked, never hardcoded in feature code.
 */

export const DEFAULT_AWS_REGION = "us-east-1";
export const DEFAULT_DYNAMODB_TABLE = "ecs-dev-desktop";

/** GitHub REST API base. Override (env) points at GitHub Enterprise or the
 * bleephub simulator's `/api/v3`; default is public GitHub. */
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

/** ECS Fargate workspace-runtime defaults (cluster / subnets / role are
 * deployment-specific and supplied by config, not defaulted). */
export const DEFAULT_ECS_CLUSTER = "edd-workspaces";
export const DEFAULT_WORKSPACE_CONTAINER = "workspace";
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

const DYNAMODB_LOCAL_HOST = "127.0.0.1";
const DYNAMODB_LOCAL_PORT = 8000;

/** DynamoDB Local (Tier-2 harness) connection config. */
export const dynamodbLocal = {
  host: DYNAMODB_LOCAL_HOST,
  port: DYNAMODB_LOCAL_PORT,
  endpoint: `http://${DYNAMODB_LOCAL_HOST}:${DYNAMODB_LOCAL_PORT}`,
} as const;

/**
 * Scheme for the local sockerless simulators (AWS / bleephub / Entra). Defaults
 * to plain HTTP; set `EDD_SIM_SCHEME=https` to drive the sims over TLS — the HTTPS
 * e2e harness mounts a self-signed cert (`SIM_TLS_CERT`/`SIM_TLS_KEY`) and the
 * client trusts its CA via `NODE_EXTRA_CA_CERTS`. Endpoint-only switch (§6.8):
 * the *real-cloud* URLs are HTTPS regardless; this only flips the sim base URLs.
 * Unset → `http` (documented default); an invalid explicit value throws (loud).
 */
const SIM_SCHEME: "http" | "https" =
  process.env.EDD_SIM_SCHEME === undefined
    ? "http"
    : z.enum(["http", "https"]).parse(process.env.EDD_SIM_SCHEME);

const AWS_SIM_HOST = "127.0.0.1";
const AWS_SIM_PORT = 4566;

/**
 * Sockerless AWS simulator (Tier-2 harness, built from source). One endpoint
 * serves the AWS API surface (EC2/EBS, DynamoDB, ECS, …); SDK clients reach it
 * via `AWS_ENDPOINT_URL`. Endpoint-only consumption — see `AGENTS.md` §6.8.
 */
export const awsSim = {
  host: AWS_SIM_HOST,
  port: AWS_SIM_PORT,
  endpoint: `${SIM_SCHEME}://${AWS_SIM_HOST}:${AWS_SIM_PORT}`,
} as const;

const BLEEPHUB_HOST = "127.0.0.1";
const BLEEPHUB_PORT = 5555;

/** bleephub — the sockerless GitHub server (e2e auth harness). `url` is the OAuth
 * root (`/login/oauth/*`); `apiUrl` is the REST base (`/api/v3`). */
export const bleephub = {
  url: `${SIM_SCHEME}://${BLEEPHUB_HOST}:${BLEEPHUB_PORT}`,
  apiUrl: `${SIM_SCHEME}://${BLEEPHUB_HOST}:${BLEEPHUB_PORT}/api/v3`,
} as const;

const ENTRA_SIM_HOST = "127.0.0.1";
const ENTRA_SIM_PORT = 4568;
/** Tenant the e2e drives. Real Entra reads the tenant from the request path; the
 * sim does the same, so any stable value works (no behaviour depends on it). */
export const ENTRA_SIM_TENANT = "edd-e2e-tenant";

/** Sockerless Azure/Entra simulator (e2e auth harness). `authority` is the OIDC
 * issuer root (`/{tenant}/oauth2/v2.0/*`); `graphUrl` is the Microsoft Graph base
 * (standard user/group provisioning + `/me/memberOf`). Both are plain base URLs:
 * against real cloud the same code points them at `login.microsoftonline.com` /
 * `graph.microsoft.com` — endpoint-only, no sim-specific paths (`AGENTS.md` §6.8). */
export const entraSim = {
  endpoint: `${SIM_SCHEME}://${ENTRA_SIM_HOST}:${ENTRA_SIM_PORT}`,
  authority: `${SIM_SCHEME}://${ENTRA_SIM_HOST}:${ENTRA_SIM_PORT}/${ENTRA_SIM_TENANT}`,
  graphUrl: `${SIM_SCHEME}://${ENTRA_SIM_HOST}:${ENTRA_SIM_PORT}/v1.0`,
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
