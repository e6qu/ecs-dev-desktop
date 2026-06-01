// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/**
 * Shared runtime environment schema. Components parse `process.env` through
 * this so misconfiguration fails fast at startup rather than at first use.
 * Extend per-component schemas with `.extend(...)`.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  DYNAMODB_TABLE: z.string().min(1).default("ecs-dev-desktop"),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): BaseEnv {
  return baseEnvSchema.parse(env);
}
