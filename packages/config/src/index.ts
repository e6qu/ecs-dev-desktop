// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/**
 * Typed configuration. Endpoints, ports, and default values live here (and in
 * per-module configs) — type-checked, never hardcoded in feature code.
 */

export const DEFAULT_AWS_REGION = "us-east-1";
export const DEFAULT_DYNAMODB_TABLE = "ecs-dev-desktop";

const DYNAMODB_LOCAL_HOST = "127.0.0.1";
const DYNAMODB_LOCAL_PORT = 8000;

/** DynamoDB Local (Tier-2 harness) connection config. */
export const dynamodbLocal = {
  host: DYNAMODB_LOCAL_HOST,
  port: DYNAMODB_LOCAL_PORT,
  endpoint: `http://${DYNAMODB_LOCAL_HOST}:${DYNAMODB_LOCAL_PORT}`,
} as const;

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
