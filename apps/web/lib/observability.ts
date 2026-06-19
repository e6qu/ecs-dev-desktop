// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { metricSinkFromEnv } from "@edd/cloudwatch-metrics";
import {
  METRIC_API_ERROR,
  METRIC_API_LATENCY_MS,
  METRIC_API_REQUEST,
  type MetricSink,
  type StructuredLogger,
} from "@edd/core";

import { errorField, log } from "./logger";

/** Response header carrying the per-request correlation id, so a user-visible error
 * can be traced to its access-log line (which logs the same `requestId`). */
export const REQUEST_ID_HEADER = "x-edd-request-id";

/**
 * Per-request observability for the API routes: latency + status + error-rate
 * metrics (CloudWatch EMF on AWS) and a structured access-log line. Applied as a
 * thin wrapper around each handler export — no Next middleware (which is edge
 * runtime, can't reach stdout, and can't see the handler's status), and no churn
 * to the handler bodies. Status is bucketed by class (`2xx`/`4xx`/`5xx`) to keep
 * the metric cardinality bounded.
 */
export interface ObservabilityDeps {
  metrics: MetricSink;
  log: StructuredLogger;
  now: () => number;
  /** Per-request correlation id source (injectable for deterministic tests). */
  id: () => string;
}

const defaultDeps: ObservabilityDeps = {
  metrics: metricSinkFromEnv(),
  log,
  now: () => Date.now(),
  id: () => randomUUID(),
};

function methodOf(first: unknown): string {
  return first instanceof Request ? first.method : "UNKNOWN";
}

function record(
  deps: ObservabilityDeps,
  route: string,
  method: string,
  status: number,
  durationMs: number,
  requestId: string,
): void {
  const statusClass = `${String(Math.floor(status / 100))}xx`;
  deps.metrics.timing(METRIC_API_LATENCY_MS, durationMs, { route, status: statusClass });
  deps.metrics.count(METRIC_API_REQUEST, 1, { route, status: statusClass });
  if (status >= 500) deps.metrics.count(METRIC_API_ERROR, 1, { route });
  deps.log.info("api request", { route, method, status, durationMs, requestId });
}

/**
 * Wrap an API route handler with request observability. Generic over the handler
 * arg shape so it covers `()`, `(req)`, and `(req, ctx)` handlers uniformly. A
 * thrown handler is recorded as a 5xx (and the error logged) before re-throwing,
 * so an uncaught failure still produces a metric.
 */
export function withObservability<A extends unknown[]>(
  route: string,
  handler: (...args: A) => Promise<Response>,
  deps: ObservabilityDeps = defaultDeps,
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    const startedMs = deps.now();
    const method = methodOf(args[0]);
    const requestId = deps.id();
    try {
      const res = await handler(...args);
      res.headers.set(REQUEST_ID_HEADER, requestId);
      record(deps, route, method, res.status, deps.now() - startedMs, requestId);
      return res;
    } catch (err) {
      // Observe and re-throw: a thrown error here is by definition UNEXPECTED (a
      // genuine 500). Handled/expected failures are returned as the appropriate
      // status by the route/service (e.g. a compute-launch failure → 503), never
      // raised. The wrapper only records + re-raises (the correlation id is in both
      // the access log and the thrown-error log).
      record(deps, route, method, 500, deps.now() - startedMs, requestId);
      deps.log.error("api request threw", { route, method, requestId, error: errorField(err) });
      throw err;
    }
  };
}
