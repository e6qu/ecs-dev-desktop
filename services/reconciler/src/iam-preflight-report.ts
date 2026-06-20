// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  METRIC_IAM_PREFLIGHT_DENIED,
  summarizeIamPreflight,
  type IamPreflightSignal,
  type MetricSink,
  type StructuredLogger,
} from "@edd/core";
import type { IamPreflightResult } from "@edd/iam-preflight";

/** The IAM component this self-check runs for (dimensions the emitted metric). */
const COMPONENT = "reconciler";

interface ReportDeps {
  readonly logger: StructuredLogger;
  readonly metrics: MetricSink;
}

/**
 * Emit the reconciler's startup IAM self-check result as one structured log line and
 * (when the simulate actually ran) one metric. Pure-ish shell glue, factored out of the
 * entrypoint so it is unit-testable without running the whole sweep. Non-fatal by design:
 * it only logs/emits — an unavailable preflight degrades to a benign `info`, never a
 * failure that could stop maintenance.
 */
export function reportIamPreflight(result: IamPreflightResult, deps: ReportDeps): void {
  const { logger, metrics } = deps;
  const signal: IamPreflightSignal = result.signal;
  const summary = summarizeIamPreflight(signal);

  // Emit the denied-count metric ONLY when the simulate actually ran; an unavailable
  // check has no ground truth to report (it would otherwise look like 0 denied = healthy).
  if (signal.kind === "checked") {
    metrics.count(METRIC_IAM_PREFLIGHT_DENIED, summary.deniedActions.length, {
      component: COMPONENT,
    });
  }

  const principalArn = result.identity?.principalArn ?? undefined;
  if (summary.deniedActions.length > 0) {
    logger.error("IAM preflight: required actions denied", {
      component: COMPONENT,
      deniedActions: summary.deniedActions.join(", "),
      deniedCount: summary.deniedActions.length,
      ...(principalArn === undefined ? {} : { principalArn }),
    });
    return;
  }
  logger.info("IAM preflight: ok", {
    component: COMPONENT,
    checked: signal.kind === "checked",
    ...(summary.reason === undefined ? {} : { reason: summary.reason }),
    ...(principalArn === undefined ? {} : { principalArn }),
  });
}
