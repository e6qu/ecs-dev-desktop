// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Config-sync (functional core): given the control plane's own configuration + a couple
 * of live dependency signals, classify whether the running deployment matches its
 * expected configuration — so an operator (UI/API/SDK/CLI) can see at a glance whether
 * the setup is wired the way it should be, or has drifted / is half-configured.
 *
 * This is the APP-level self-check (what the control plane can observe about itself). It
 * complements, but does not replace, a deploy-time `terraform plan` drift gate for the
 * infrastructure the app can't see (VPC/IAM/ALB/DNS); that is tracked separately.
 *
 * Pure: data in (env snapshot + dependency statuses) → a report out. No I/O.
 */

import {
  evaluateIamPermissions,
  type IamIdentity,
  type IamPreflightSignal,
} from "./iam-requirements";

/** A live dependency signal the shell gathers (health checks). */
export type DependencyStatus = "ok" | "down" | "unknown";

/** One configuration check + its outcome. */
export interface ConfigCheck {
  readonly name: string;
  /** `ok` = as expected; `drift` = misconfigured/missing vs a real deployment;
   * `unknown` = can't tell (e.g. a dev/fakes run, or a dependency not checkable here). */
  readonly status: "ok" | "drift" | "unknown";
  readonly detail: string;
}

export interface ConfigSyncReport {
  /** True iff no check is in `drift` (the deployment matches its expected config). */
  readonly inSync: boolean;
  readonly checks: readonly ConfigCheck[];
  /** The resolved AWS caller identity, when known (real deployment). */
  readonly identity?: IamIdentity;
}

export interface ConfigSyncInput {
  /** Relevant control-plane environment (only the keys below are read). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** DynamoDB reachability (from the health board). */
  readonly dynamodb: DependencyStatus;
  /** Compute cluster reachability/ACTIVE (from the health board). */
  readonly compute: DependencyStatus;
  /**
   * Live IAM preflight for the control plane's own identity (the shell runs
   * `iam:SimulatePrincipalPolicy` over {@link IAM_REQUIREMENTS}). Omitted in
   * dev/fakes; classifies as `unknown` when the check can't run.
   */
  readonly iam?: IamPreflightSignal;
  /** The resolved AWS caller identity (from the same preflight), surfaced verbatim. */
  readonly iamIdentity?: IamIdentity;
}

/** Coordinates the real ECS/EBS adapters require to launch + manage workspaces. A
 * missing one means a real deploy can't fully function — drift. */
const REQUIRED_ECS_COORDINATES = [
  "ECS_CLUSTER",
  "ECS_SUBNETS",
  "ECS_SECURITY_GROUPS",
  "ECS_EBS_ROLE_ARN",
  "ECS_EXECUTION_ROLE_ARN",
  "ECS_TASK_ROLE_ARN",
  "CONTROL_PLANE_URL",
] as const;

/** The expected production observability wiring (CloudTrail audit + CloudWatch logs). */
const OBSERVABILITY_COORDINATES = [
  "AUDIT_PROVIDER",
  "LOG_PROVIDER",
  "EDD_APP_NAME",
  "ECS_LOG_GROUP_WORKSPACES",
] as const;

function present(env: ConfigSyncInput["env"], key: string): boolean {
  const v = env[key];
  return v !== undefined && v.length > 0;
}

function missing(env: ConfigSyncInput["env"], keys: readonly string[]): string[] {
  return keys.filter((k) => !present(env, k));
}

function dependencyCheck(name: string, status: DependencyStatus, label: string): ConfigCheck {
  switch (status) {
    case "ok":
      return { name, status: "ok", detail: `${label} reachable` };
    case "down":
      return { name, status: "drift", detail: `${label} unreachable` };
    case "unknown":
      return { name, status: "unknown", detail: `${label} not checked (real-AWS only)` };
  }
}

export function evaluateConfigSync(input: ConfigSyncInput): ConfigSyncReport {
  const { env } = input;
  const checks: ConfigCheck[] = [];

  // 1) Provider mode: a real deployment runs the ECS/EBS adapters; anything else is the
  //    in-process fakes — fine in dev, drift for a deployment expected to be real.
  const real = env.COMPUTE_PROVIDER === "ecs";
  checks.push({
    name: "compute-provider",
    status: real ? "ok" : "unknown",
    detail: real
      ? "real ECS/EBS adapters selected (COMPUTE_PROVIDER=ecs)"
      : "in-process fakes (COMPUTE_PROVIDER!=ecs) — dev/test, not a real deployment",
  });

  // 2) Required coordinates for the real adapters — only meaningful when real.
  if (real) {
    const gaps = missing(env, REQUIRED_ECS_COORDINATES);
    checks.push({
      name: "ecs-coordinates",
      status: gaps.length === 0 ? "ok" : "drift",
      detail:
        gaps.length === 0
          ? "all ECS/EBS coordinates present"
          : `missing required coordinates: ${gaps.join(", ")}`,
    });
    const obsGaps = missing(env, OBSERVABILITY_COORDINATES);
    checks.push({
      name: "observability-config",
      status: obsGaps.length === 0 ? "ok" : "drift",
      detail:
        obsGaps.length === 0
          ? "CloudTrail/CloudWatch observability wired"
          : `missing observability config: ${obsGaps.join(", ")}`,
    });
  }

  // 3) Live dependency signals (from the health board).
  checks.push(dependencyCheck("dynamodb", input.dynamodb, "DynamoDB"));
  checks.push(dependencyCheck("compute-cluster", input.compute, "ECS cluster"));

  // 4) IAM preflight: does the control plane's own identity actually hold the
  //    permissions its components need? Only meaningful where a real role+policy is
  //    deployed; `unknown` otherwise (the shell omits the signal off real AWS).
  if (input.iam !== undefined) {
    checks.push(evaluateIamPermissions("control-plane", input.iam));
  }

  const inSync = checks.every((c) => c.status !== "drift");
  return input.iamIdentity !== undefined
    ? { inSync, checks, identity: input.iamIdentity }
    : { inSync, checks };
}
