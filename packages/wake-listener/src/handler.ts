// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AWS Lambda "wake listener" for control-plane scale-to-zero (imperative shell).
 *
 * When the control-plane ECS service is scaled to zero, CloudFront fails over to
 * this Lambda (wired as a Function URL origin). The handler:
 *   1. reads the control-plane service's current desired count (`DescribeServices`),
 *   2. asks the pure core (`decideControlPlaneWake`) whether to scale up, and if
 *      so calls `UpdateService` to set the active desired count (idempotent — a
 *      concurrent invoke that finds it already at desired holds), then
 *   3. returns the self-refreshing "Starting EDD…" status page (rendered by the
 *      pure core) that polls the readiness coordinate and reloads into the app.
 *
 * This file is the thin I/O shell: it wires env → core → response and performs
 * the ECS calls through the injected {@link EcsServicePort}. All rendering and
 * response-shaping logic lives in `@edd/core`.
 *
 * Env contract:
 *   ECS_CLUSTER                       (required) control-plane cluster name/ARN
 *   EDD_CONTROL_PLANE_SERVICE         (required) control-plane ECS service name
 *   EDD_CONTROL_PLANE_ACTIVE_DESIRED  (optional) wake target; default DEFAULT_CONTROL_PLANE_ACTIVE_DESIRED
 *   EDD_WAKE_RELOAD_INTERVAL_MS       (optional) page reload cadence; default DEFAULT_WAKE_RELOAD_INTERVAL_MS
 *   EDD_WAKE_PAGE_TITLE               (optional) page title; default DEFAULT_WAKE_PAGE_TITLE
 *   AWS_REGION, AWS_ENDPOINT_URL      (optional) SDK coordinates (§6.9)
 */
import {
  DEFAULT_CONTROL_PLANE_ACTIVE_DESIRED,
  DEFAULT_WAKE_PAGE_TITLE,
  DEFAULT_WAKE_RELOAD_INTERVAL_MS,
  createLogger,
  decideControlPlaneWake,
  decideWakeResponse,
  systemClock,
  type StructuredLogger,
  type WakeHttpResponse,
} from "@edd/core";

import { ecsClientFromEnv, ecsServiceFromClient, type EcsServicePort } from "./ecs-service";

type Env = Readonly<Record<string, string | undefined>>;

/** Env var names the handler reads (no magic strings). */
export const WAKE_ENV = {
  cluster: "ECS_CLUSTER",
  service: "EDD_CONTROL_PLANE_SERVICE",
  activeDesired: "EDD_CONTROL_PLANE_ACTIVE_DESIRED",
  reloadIntervalMs: "EDD_WAKE_RELOAD_INTERVAL_MS",
  pageTitle: "EDD_WAKE_PAGE_TITLE",
} as const;

/**
 * Minimal AWS Lambda Function URL request (payload format 2.0) — only the fields
 * the wake listener reads. Kept local (strongly typed, no `any`) so the package
 * needs no `@types/aws-lambda`.
 */
export interface FunctionUrlEvent {
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly http?: { readonly method?: string; readonly path?: string };
  };
}

/** AWS Lambda Function URL response (payload format 2.0). Structurally the same
 * shape the pure core produces. */
export type FunctionUrlResult = WakeHttpResponse;

/** Dependencies the orchestration needs, injected for tests. */
export interface WakeDeps {
  readonly ecs: EcsServicePort;
  readonly env: Env;
  readonly logger: StructuredLogger;
}

function requiredEnv(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`wake-listener: missing required env ${key}`);
  }
  return value;
}

function positiveIntEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`wake-listener: ${key} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function titleEnv(env: Env): string {
  const raw = env[WAKE_ENV.pageTitle];
  return raw !== undefined && raw.length > 0 ? raw : DEFAULT_WAKE_PAGE_TITLE;
}

/**
 * Orchestrate one wake invocation (testable; deps injected). Reads the service
 * scale, decides via the pure core, scales up on `wake`, and returns the startup
 * page. Fails loud on a missing env var or an ECS error.
 */
export async function handleWake(
  event: FunctionUrlEvent,
  deps: WakeDeps,
): Promise<FunctionUrlResult> {
  const { env, ecs, logger } = deps;
  const cluster = requiredEnv(env, WAKE_ENV.cluster);
  const service = requiredEnv(env, WAKE_ENV.service);
  const activeDesired = positiveIntEnv(
    env,
    WAKE_ENV.activeDesired,
    DEFAULT_CONTROL_PLANE_ACTIVE_DESIRED,
  );
  const reloadIntervalMs = positiveIntEnv(
    env,
    WAKE_ENV.reloadIntervalMs,
    DEFAULT_WAKE_RELOAD_INTERVAL_MS,
  );
  const title = titleEnv(env);
  const page = { reloadIntervalMs, title };

  // Every request here is CloudFront serving this Lambda for a 503 from the ALB (via the 503
  // custom_error_response) — i.e. the control plane is down. There is no readiness-probe vs
  // navigation distinction: we always trigger the wake and return the reloading page. `event` is
  // unused (the wake decision depends only on the current ECS scale), kept for the handler shape.
  void event;

  try {
    const scale = await ecs.describe({ cluster, service });
    const decision = decideControlPlaneWake({ currentDesired: scale.desiredCount, activeDesired });

    if (decision.action === "wake") {
      await ecs.setDesiredCount({ cluster, service, desiredCount: decision.to });
      logger.info("control-plane wake", {
        cluster,
        service,
        from: scale.desiredCount,
        to: decision.to,
      });
    } else {
      logger.info("control-plane wake hold", {
        cluster,
        service,
        desired: scale.desiredCount,
        reason: decision.reason,
      });
    }
    return decideWakeResponse({ decision, page });
  } catch (e) {
    // ECS unreachable/throttled: DON'T return a raw 5xx (CloudFront's error handler would swallow
    // it). Keep the browser retrying by serving the reloading page, and log loudly so the alarm
    // fires. The reconciler is the backstop that never scales-to-zero on error.
    logger.error("control-plane wake failed to reach ECS", {
      cluster,
      service,
      error: e instanceof Error ? e.message : String(e),
    });
    return decideWakeResponse({ decision: { action: "hold", reason: "ecs unreachable" }, page });
  }
}

/** Build the real deps from the ambient environment. */
export function wakeDepsFromEnv(env: Env = process.env): WakeDeps {
  return {
    ecs: ecsServiceFromClient(ecsClientFromEnv(env)),
    env,
    logger: createLogger({
      service: "wake-listener",
      clock: systemClock,
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    }),
  };
}

/** Lambda Function URL entrypoint (`handler.handler`). */
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  return handleWake(event, wakeDepsFromEnv());
}
