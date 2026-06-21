// SPDX-License-Identifier: AGPL-3.0-or-later
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DEFAULT_AWS_REGION } from "@edd/config";
import {
  IAM_CONTEXT_TOKENS,
  IAM_REQUIREMENTS,
  type IamActionDecision,
  type IamComponent,
  type IamIdentity,
  type IamPreflightSignal,
  type IamRequirement,
  type IamResourceScope,
} from "@edd/core";

/**
 * Live IAM preflight (imperative shell): does the control plane's OWN identity
 * actually hold the actions its components need? Asks `iam:SimulatePrincipalPolicy`
 * for each required action with the resource + condition context the scoped grants
 * need, and returns an {@link IamPreflightSignal} the pure core folds into the
 * config-sync report. Endpoint-only (AGENTS.md §6.9) — the same code hits the sim or
 * real AWS by `AWS_ENDPOINT_URL` alone.
 *
 * It self-reports `unavailable` (→ `unknown`, never a false `drift`) when there is no
 * real identity to check (dev/fakes), when the deployment coordinates needed to build
 * representative resource ARNs are absent, or when `iam:SimulatePrincipalPolicy`
 * itself is not permitted.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Representative resource ARNs (built from the caller account + live coordinates)
 * that match the deployed policy's resource patterns, so a scoped grant evaluates. */
export interface PreflightCoordinates {
  readonly account: string;
  readonly region: string;
  readonly clusterArn: string;
  readonly tableArn: string;
  readonly logGroupArn: string;
  readonly secretArn: string;
  readonly taskRoleArns: readonly string[];
}

/**
 * Convert an STS caller ARN to the IAM role ARN `SimulatePrincipalPolicy` needs:
 * `…:assumed-role/<Role>/<session>` → `…:role/<Role>`. A plain role/user ARN passes
 * through; anything else (e.g. the account root) → null (can't simulate a principal).
 */
export function callerToPrincipalArn(callerArn: string | undefined): string | null {
  if (callerArn === undefined || callerArn.length === 0) return null;
  const assumed = /^arn:(aws[\w-]*):sts::(\d+):assumed-role\/([^/]+)\/.+$/.exec(callerArn);
  if (assumed) {
    const [, partition, account, role] = assumed;
    return `arn:${partition}:iam::${account}:role/${role}`;
  }
  if (/^arn:[\w-]+:iam::\d+:(role|user)\/.+$/.test(callerArn)) return callerArn;
  return null;
}

/** Resolve the representative resource ARNs from env coordinates + the caller account.
 * Returns the coordinates, or the list of missing coordinate keys. */
export function resolveCoordinates(
  env: Env,
  account: string,
): { ok: true; coords: PreflightCoordinates } | { ok: false; missing: string[] } {
  const region = env.AWS_REGION ?? DEFAULT_AWS_REGION;
  const cluster = env.ECS_CLUSTER;
  const table = env.DYNAMODB_TABLE;
  const logGroup = env.ECS_LOG_GROUP_WORKSPACES;
  const taskRole = env.ECS_TASK_ROLE_ARN;
  const missing: string[] = [];
  if (cluster === undefined || cluster.length === 0) missing.push("ECS_CLUSTER");
  if (table === undefined || table.length === 0) missing.push("DYNAMODB_TABLE");
  if (logGroup === undefined || logGroup.length === 0) missing.push("ECS_LOG_GROUP_WORKSPACES");
  if (taskRole === undefined || taskRole.length === 0) missing.push("ECS_TASK_ROLE_ARN");
  if (
    cluster === undefined ||
    table === undefined ||
    logGroup === undefined ||
    taskRole === undefined ||
    missing.length > 0
  ) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    coords: {
      account,
      region,
      clusterArn: `arn:aws:ecs:${region}:${account}:cluster/${cluster}`,
      tableArn: `arn:aws:dynamodb:${region}:${account}:table/${table}`,
      logGroupArn: `arn:aws:logs:${region}:${account}:log-group:${logGroup}:*`,
      // A representative ARN under the `edd/workspace/*` name prefix the policy scopes to.
      secretArn: `arn:aws:secretsmanager:${region}:${account}:secret:edd/workspace/preflight-probe`,
      taskRoleArns: [taskRole],
    },
  };
}

/** The resource ARNs to simulate a statement against, by its declared scope. */
export function resourceArnsForScope(
  scope: IamResourceScope,
  coords: PreflightCoordinates,
): string[] {
  switch (scope) {
    case "any":
      return ["*"];
    case "dynamodb-table":
      return [coords.tableArn, `${coords.tableArn}/index/*`];
    case "log-groups":
      return [coords.logGroupArn];
    case "workspace-secrets":
      return [coords.secretArn];
    case "task-roles":
      return [...coords.taskRoleArns];
  }
}

/** One `SimulatePrincipalPolicy` request derived from a requirement. */
export interface SimulationRequest {
  readonly actions: readonly string[];
  readonly resourceArns: readonly string[];
  readonly context: readonly {
    readonly ContextKeyName: string;
    readonly ContextKeyValues: readonly string[];
    readonly ContextKeyType: "string";
  }[];
}

/** Build the per-statement simulate requests, substituting coordinate tokens into
 * condition values (only `${ECS_CLUSTER_ARN}` today). Pure. */
export function buildSimulationRequests(
  reqs: readonly IamRequirement[],
  coords: PreflightCoordinates,
): SimulationRequest[] {
  return reqs.map((req) => ({
    actions: req.actions,
    resourceArns: resourceArnsForScope(req.resource, coords),
    context: (req.context ?? []).map((c) => ({
      ContextKeyName: c.key,
      ContextKeyValues: c.values.map((v) =>
        v === IAM_CONTEXT_TOKENS.ecsClusterArn ? coords.clusterArn : v,
      ),
      ContextKeyType: c.type,
    })),
  }));
}

/** Map AWS `EvaluationResult[]` to our action decisions. An action counts as allowed
 * only when `EvalDecision === "allowed"` AND no `MissingContextValues` are present: per
 * the IAM Simulate API, a result with missing context is PROVISIONAL — AWS couldn't
 * fully evaluate a condition, so a provisional "allowed" must not read as a definitive
 * allow (that would let the preflight report green while a condition gate is actually
 * unevaluated). Treating it as not-allowed surfaces the gap instead (fail-closed). */
export function decisionsFromEvaluationResults(
  results: readonly {
    EvalActionName?: string;
    EvalDecision?: string;
    MissingContextValues?: string[];
  }[],
): IamActionDecision[] {
  const out: IamActionDecision[] = [];
  for (const r of results) {
    if (r.EvalActionName === undefined) continue;
    const conclusivelyAllowed =
      r.EvalDecision === "allowed" && (r.MissingContextValues?.length ?? 0) === 0;
    out.push({ action: r.EvalActionName, allowed: conclusivelyAllowed });
  }
  return out;
}

interface ClientConfig {
  readonly region: string;
  /** Fail fast: a preflight that can't reach STS/IAM should degrade to `unknown`
   * quickly, not retry-storm and stall the admin page render. */
  readonly maxAttempts: number;
  readonly endpoint?: string;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
}

function clientConfig(): ClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
  return endpoint !== undefined && endpoint.length > 0
    ? {
        region,
        maxAttempts: 2,
        endpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : { region, maxAttempts: 2 };
}

const unavailable = (reason: string): IamPreflightSignal => ({ kind: "unavailable", reason });

/** The preflight outcome: the permission signal + the resolved caller identity
 * (known once `GetCallerIdentity` succeeds, even if the simulate later can't run). */
export interface IamPreflightResult {
  readonly signal: IamPreflightSignal;
  readonly identity: IamIdentity | null;
}

/**
 * Run the live preflight for a component's identity. Defaults to the control plane —
 * the only identity the web process can introspect (the reconciler's grants are
 * covered by the CI drift gate over the same {@link IAM_REQUIREMENTS} manifest).
 */
export async function iamPreflight(
  env: Env = process.env,
  component: IamComponent = "control-plane",
): Promise<IamPreflightResult> {
  // No real identity to check when the fakes are selected.
  if (env.COMPUTE_PROVIDER !== "ecs") {
    return { signal: unavailable("dev/fakes (COMPUTE_PROVIDER!=ecs)"), identity: null };
  }

  let identity: IamIdentity;
  try {
    const sts = new STSClient(clientConfig());
    const caller = await sts.send(new GetCallerIdentityCommand({}));
    identity = {
      account: caller.Account ?? "",
      callerArn: caller.Arn ?? "",
      principalArn: callerToPrincipalArn(caller.Arn),
    };
  } catch (e) {
    return {
      signal: unavailable(`sts:GetCallerIdentity failed (${(e as Error).name})`),
      identity: null,
    };
  }
  if (identity.principalArn === null) {
    return { signal: unavailable("caller is not an assumable role/user"), identity };
  }

  const account =
    identity.account.length > 0
      ? identity.account
      : (/::(\d+):/.exec(identity.principalArn)?.[1] ?? "");
  const resolved = resolveCoordinates(env, account);
  if (!resolved.ok) {
    return { signal: unavailable(`missing coordinates: ${resolved.missing.join(", ")}`), identity };
  }

  const requests = buildSimulationRequests(IAM_REQUIREMENTS[component], resolved.coords);
  const iam = new IAMClient(clientConfig());
  const decisions: IamActionDecision[] = [];
  try {
    for (const req of requests) {
      const out = await iam.send(
        new SimulatePrincipalPolicyCommand({
          PolicySourceArn: identity.principalArn,
          ActionNames: [...req.actions],
          ResourceArns: [...req.resourceArns],
          ContextEntries: req.context.map((c) => ({
            ContextKeyName: c.ContextKeyName,
            ContextKeyValues: [...c.ContextKeyValues],
            ContextKeyType: c.ContextKeyType,
          })),
        }),
      );
      decisions.push(...decisionsFromEvaluationResults(out.EvaluationResults ?? []));
    }
  } catch (e) {
    return {
      signal: unavailable(`iam:SimulatePrincipalPolicy not permitted (${(e as Error).name})`),
      identity,
    };
  }
  return { signal: { kind: "checked", decisions }, identity };
}
