// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigCheck } from "./config-sync";

/**
 * IAM requirements (functional core): the single source of truth for the IAM
 * actions each runtime component needs, plus the condition context that makes a
 * scoped grant evaluate. Two consumers share this manifest so they can never drift:
 *
 *   1. The runtime self-check (`evaluateIamPermissions`) — the control plane asks
 *      `iam:SimulatePrincipalPolicy` whether its own identity is actually allowed
 *      each required action, and surfaces the result in the config-sync report.
 *   2. The CI drift gate (terraform-sim) — asserts the deployed role policy grants
 *      every action here (so the IaC and the app can't silently diverge).
 *
 * Derived from `infra/terraform/modules/ecs-dev-desktop/iam.tf` (the least-privilege
 * task-role policies). Keep this list and that policy in lock-step — the drift gate
 * fails if they part ways.
 *
 * Pure: data + a pure evaluator. No I/O. The imperative shell resolves coordinate
 * tokens (below) and performs the simulate calls.
 */

/** A runtime component that runs under its own IAM task role. */
export type IamComponent = "control-plane" | "reconciler";

/**
 * A condition-context entry a scoped statement needs to evaluate `Allow`. A value
 * may be a literal or a `${TOKEN}` the consumer resolves from live coordinates
 * (only {@link IAM_CONTEXT_TOKENS} are defined).
 */
export interface IamConditionContext {
  readonly key: string;
  readonly values: readonly string[];
  readonly type: "string";
}

/**
 * The resource a statement is scoped to — a hint the live simulate uses to choose
 * `ResourceArns`. `any` = granted on `*` (simulate against `*`); the others are
 * resolved to representative ARNs by the shell from live coordinates.
 */
export type IamResourceScope =
  | "any"
  | "dynamodb-table"
  | "log-groups"
  | "workspace-secrets"
  | "task-roles";

/** One policy statement's worth of required actions + the context it needs. */
export interface IamRequirement {
  /** Matches the terraform statement `sid` — the join key for the drift gate. */
  readonly sid: string;
  readonly actions: readonly string[];
  readonly resource: IamResourceScope;
  readonly context?: readonly IamConditionContext[];
}

/** Coordinate tokens the shell substitutes into condition values before simulating. */
export const IAM_CONTEXT_TOKENS = {
  /** The ECS cluster ARN (`ecs:cluster` condition). */
  ecsClusterArn: "${ECS_CLUSTER_ARN}",
} as const;

const CONTROL_PLANE_REQUIREMENTS: readonly IamRequirement[] = [
  {
    sid: "DynamoSingleTable",
    resource: "dynamodb-table",
    actions: [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ],
  },
  {
    sid: "DecryptSingleTable",
    resource: "any",
    actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
  },
  {
    sid: "RunAndManageWorkspaceTasks",
    resource: "any",
    actions: [
      "ecs:RunTask",
      "ecs:StopTask",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:TagResource",
    ],
    context: [{ key: "ecs:cluster", values: [IAM_CONTEXT_TOKENS.ecsClusterArn], type: "string" }],
  },
  {
    sid: "ManagedEbsLifecycle",
    resource: "any",
    actions: [
      "ec2:CreateVolume",
      "ec2:CreateSnapshot",
      "ec2:CreateTags",
      "ec2:DescribeVolumes",
      "ec2:DescribeSnapshots",
      "ec2:DescribeTags",
    ],
  },
  {
    sid: "ReapManagedEbsOnly",
    resource: "any",
    actions: ["ec2:DeleteVolume", "ec2:DeleteSnapshot", "ec2:DetachVolume"],
    context: [{ key: "aws:ResourceTag/edd:managed", values: ["true"], type: "string" }],
  },
  {
    sid: "PassTaskRoles",
    resource: "task-roles",
    actions: ["iam:PassRole"],
    context: [{ key: "iam:PassedToService", values: ["ecs-tasks.amazonaws.com"], type: "string" }],
  },
  {
    sid: "ManageWorkspaceAgentSecrets",
    resource: "workspace-secrets",
    actions: [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:DescribeSecret",
      "secretsmanager:DeleteSecret",
    ],
  },
  {
    sid: "Logs",
    resource: "log-groups",
    actions: [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
    ],
  },
  {
    sid: "CloudTrailLookup",
    resource: "any",
    actions: ["cloudtrail:LookupEvents"],
  },
];

const RECONCILER_REQUIREMENTS: readonly IamRequirement[] = [
  {
    sid: "DynamoSingleTable",
    resource: "dynamodb-table",
    actions: [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ],
  },
  {
    sid: "DecryptSingleTable",
    resource: "any",
    actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
  },
  {
    sid: "StopIdleTasks",
    resource: "any",
    actions: ["ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks"],
    context: [{ key: "ecs:cluster", values: [IAM_CONTEXT_TOKENS.ecsClusterArn], type: "string" }],
  },
  {
    sid: "SnapshotAndGc",
    resource: "any",
    actions: [
      "ec2:CreateSnapshot",
      "ec2:CreateTags",
      "ec2:DescribeVolumes",
      "ec2:DescribeSnapshots",
      "ec2:DescribeTags",
    ],
  },
  {
    sid: "ReapManagedEbsOnly",
    resource: "any",
    actions: ["ec2:DeleteVolume", "ec2:DeleteSnapshot"],
    context: [{ key: "aws:ResourceTag/edd:managed", values: ["true"], type: "string" }],
  },
  {
    sid: "ListSecretsForReaping",
    resource: "any",
    actions: ["secretsmanager:ListSecrets"],
  },
  {
    sid: "ReapWorkspaceAgentSecrets",
    resource: "workspace-secrets",
    actions: ["secretsmanager:DeleteSecret"],
  },
  {
    sid: "PruneWorkspaceTaskDefinitions",
    resource: "any",
    actions: [
      "ecs:ListTaskDefinitionFamilies",
      "ecs:ListTaskDefinitions",
      "ecs:DeregisterTaskDefinition",
    ],
  },
];

/** The required IAM actions per component — the single source of truth. */
export const IAM_REQUIREMENTS: Readonly<Record<IamComponent, readonly IamRequirement[]>> = {
  "control-plane": CONTROL_PLANE_REQUIREMENTS,
  reconciler: RECONCILER_REQUIREMENTS,
};

/** Every required action for a component, flattened + de-duplicated, sorted. */
export function requiredActions(component: IamComponent): readonly string[] {
  const seen = new Set<string>();
  for (const req of IAM_REQUIREMENTS[component]) {
    for (const a of req.actions) seen.add(a);
  }
  return [...seen].sort();
}

/**
 * The deployment's resolved AWS caller identity (from `sts:GetCallerIdentity`),
 * surfaced to operators so they can see *which* principal the control plane runs as.
 * `principalArn` is the IAM role ARN the preflight simulates (null if the caller
 * isn't an assumable role/user).
 */
export interface IamIdentity {
  readonly account: string;
  readonly callerArn: string;
  readonly principalArn: string | null;
}

/** The decision the live `iam:SimulatePrincipalPolicy` returned for one action. */
export interface IamActionDecision {
  readonly action: string;
  readonly allowed: boolean;
}

/**
 * The live preflight signal the shell hands the evaluator: either the simulate
 * decisions, or that the check could not run (no real identity / simulate not
 * permitted / off real AWS) — the latter classifies as `unknown`, never `drift`.
 */
export type IamPreflightSignal =
  | { readonly kind: "checked"; readonly decisions: readonly IamActionDecision[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Pure: fold a component's live preflight signal into a config-sync check.
 * `unavailable → unknown`; all-allowed → `ok`; any denied (or a required action
 * the simulate never returned) → `drift`, naming the offending actions.
 */
export function evaluateIamPermissions(
  component: IamComponent,
  signal: IamPreflightSignal,
): ConfigCheck {
  const name = `iam-permissions:${component}`;
  if (signal.kind === "unavailable") {
    return {
      name,
      status: "unknown",
      detail: `live IAM preflight not run (${signal.reason})`,
    };
  }
  const required = requiredActions(component);
  const allowed = new Set(signal.decisions.filter((d) => d.allowed).map((d) => d.action));
  const denied = required.filter((a) => !allowed.has(a));
  if (denied.length === 0) {
    return {
      name,
      status: "ok",
      detail: `all ${required.length.toString()} required actions allowed`,
    };
  }
  return {
    name,
    status: "drift",
    detail: `${denied.length.toString()}/${required.length.toString()} required actions denied: ${denied.join(", ")}`,
  };
}

/** A flat, log/metric-friendly summary of a component's live IAM preflight. */
export interface IamPreflightSummary {
  /** True when the identity holds every checked action — or when the check could
   * not run (degrades to unknown, never a false failure). */
  readonly ok: boolean;
  /** The denied action names (empty when ok or when the check was unavailable). */
  readonly deniedActions: string[];
  /** Why the check could not run, when the signal was `unavailable`. */
  readonly reason?: string;
}

/**
 * Pure: reduce a live preflight {@link IamPreflightSignal} to a flat summary the
 * imperative shell can log and emit a metric from. A `checked` signal is `ok` iff no
 * decision was denied, with the denied action names listed. An `unavailable` signal
 * degrades to `ok: true` (unknown, never a false failure) carrying its `reason`.
 */
export function summarizeIamPreflight(signal: IamPreflightSignal): IamPreflightSummary {
  if (signal.kind === "unavailable") {
    return { ok: true, deniedActions: [], reason: signal.reason };
  }
  const deniedActions = signal.decisions.filter((d) => !d.allowed).map((d) => d.action);
  return { ok: deniedActions.length === 0, deniedActions };
}
