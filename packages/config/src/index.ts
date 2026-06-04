// SPDX-License-Identifier: AGPL-3.0-or-later
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
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/home/coder";
export const DEFAULT_WORKSPACE_VOLUME_GIB = 8;
export const DEFAULT_WORKSPACE_CPU = "512";
export const DEFAULT_WORKSPACE_MEMORY = "1024";

const DYNAMODB_LOCAL_HOST = "127.0.0.1";
const DYNAMODB_LOCAL_PORT = 8000;

/** DynamoDB Local (Tier-2 harness) connection config. */
export const dynamodbLocal = {
  host: DYNAMODB_LOCAL_HOST,
  port: DYNAMODB_LOCAL_PORT,
  endpoint: `http://${DYNAMODB_LOCAL_HOST}:${DYNAMODB_LOCAL_PORT}`,
} as const;

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
  endpoint: `http://${AWS_SIM_HOST}:${AWS_SIM_PORT}`,
} as const;

const BLEEPHUB_HOST = "127.0.0.1";
const BLEEPHUB_PORT = 5555;

/** bleephub — the sockerless GitHub server (e2e auth harness). `url` is the OAuth
 * root (`/login/oauth/*`); `apiUrl` is the REST base (`/api/v3`). */
export const bleephub = {
  url: `http://${BLEEPHUB_HOST}:${BLEEPHUB_PORT}`,
  apiUrl: `http://${BLEEPHUB_HOST}:${BLEEPHUB_PORT}/api/v3`,
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
  endpoint: `http://${ENTRA_SIM_HOST}:${ENTRA_SIM_PORT}`,
  authority: `http://${ENTRA_SIM_HOST}:${ENTRA_SIM_PORT}/${ENTRA_SIM_TENANT}`,
  graphUrl: `http://${ENTRA_SIM_HOST}:${ENTRA_SIM_PORT}/v1.0`,
} as const;

/**
 * Default per-role cap on the number of workspaces a user may own (`null` =
 * unlimited). Overridable per role via `EDD_QUOTA_<ROLE>` (e.g. `EDD_QUOTA_MEMBER=10`).
 */
export const DEFAULT_WORKSPACE_QUOTAS: Record<string, number | null> = {
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
