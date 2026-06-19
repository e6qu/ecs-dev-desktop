// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Metric emission port. The functional core stays pure; the imperative shell
 * (control plane, reconciler) emits operational metrics through this sink. Real
 * deployments wire a CloudWatch adapter (`@edd/cloudwatch-metrics`, EMF over
 * stdout); locally/in tests the no-op or in-memory sink is used. Like every other
 * port, the producer code is identical against the sim or real cloud (§6.8).
 */
export type MetricDimensions = Readonly<Record<string, string>>;

export interface MetricSink {
  /** A counter increment (default 1). */
  count(name: string, value?: number, dimensions?: MetricDimensions): void;
  /** A point-in-time value (e.g. a fleet size). */
  gauge(name: string, value: number, dimensions?: MetricDimensions): void;
  /** A duration in milliseconds (e.g. wake latency). */
  timing(name: string, milliseconds: number, dimensions?: MetricDimensions): void;
}

/** CloudWatch namespace for emitted metrics. */
export const EDD_METRIC_NAMESPACE = "edd/control-plane";

// Metric names — named constants so call sites carry no magic strings (§6.2).
/** Wake-on-connect / start cold-start latency (RunTask → routable), in ms. */
export const METRIC_WORKSPACE_WAKE_LATENCY_MS = "workspace.wake.latency_ms";
/** One reconciler maintenance sweep ran to completion. */
export const METRIC_RECONCILER_SWEEP = "reconciler.sweep.count";
/** A reconciler sweep threw before completing. */
export const METRIC_RECONCILER_FAILED = "reconciler.sweep.failed";
/** Idle workspaces scaled to zero in a sweep. */
export const METRIC_RECONCILER_STOPPED = "reconciler.idle.stopped";
/** Scheduled snapshots taken in a sweep. */
export const METRIC_RECONCILER_SNAPSHOTTED = "reconciler.snapshots.taken";
/** Drifted records (task gone out-of-band) reconciled in a sweep. */
export const METRIC_RECONCILER_DRIFT_LOST = "reconciler.drift.lost";
/** Orphan volumes + snapshots garbage-collected in a sweep. */
export const METRIC_RECONCILER_GC_DELETED = "reconciler.gc.deleted";
/** Orphan deletes that errored (e.g. a volume transiently in-use). Best-effort GC
 * counts and continues rather than aborting the sweep; a non-zero value warrants
 * a look (an orphan kept failing to reap). */
export const METRIC_RECONCILER_GC_FAILED = "reconciler.gc.failed";
/** Orphaned workspace tasks reaped: RUNNING tasks no live workspace references
 * (a record was deleted/never-persisted), self-healed by stopping them. */
export const METRIC_RECONCILER_TASKS_REAPED = "reconciler.tasks.reaped";
/** Orphan-task stops that errored (best-effort, counted and logged). */
export const METRIC_RECONCILER_TASKS_REAP_FAILED = "reconciler.tasks.reap_failed";
/** Workspaces reverted from a crashed wake (stuck `provisioning` → `stopped`),
 * self-healed by the reconciler so they become wake-able again. */
export const METRIC_RECONCILER_PROVISIONING_RECOVERED = "reconciler.provisioning.recovered";
/** Actions skipped because a concurrent update won the race (not failures). */
export const METRIC_RECONCILER_SKIPPED = "reconciler.skipped";
/** Workspaces recovered `error → stopped` (had a snapshot) — converged toward working. */
export const METRIC_RECONCILER_RECOVERED = "reconciler.recovered";
/** `deleting` tombstones whose teardown was finished + record removed this sweep. */
export const METRIC_RECONCILER_DELETIONS_FINISHED = "reconciler.deletions.finished";
/** Finish-delete attempts that failed (e.g. a transient final-snapshot error) and
 * will be retried next sweep — a persistently non-zero value needs a human. */
export const METRIC_RECONCILER_DELETIONS_FAILED = "reconciler.deletions.failed";
/** Workspaces marked unrecoverable `error` because a referenced snapshot was deleted
 * out-of-band (reverse drift). */
export const METRIC_RECONCILER_SNAPSHOT_LOST = "reconciler.drift.snapshot_lost";
/** Gauge: workspaces currently stuck in `error` (recovery couldn't move them forward —
 * unrecoverable, awaiting a human or delete). */
export const METRIC_RECONCILER_ERROR_GAUGE = "reconciler.workspaces.error";
/** Gauge: workspaces currently in the `deleting` tombstone (teardown in progress). */
export const METRIC_RECONCILER_DELETING_GAUGE = "reconciler.workspaces.deleting";

// API request metrics (emitted by the route observability wrapper).
/** One handled API request (dimensioned by route + status class). */
export const METRIC_API_REQUEST = "api.request";
/** API request handler latency, in ms. */
export const METRIC_API_LATENCY_MS = "api.request.latency_ms";
/** An API request that produced a 5xx (or threw). */
export const METRIC_API_ERROR = "api.request.error";
/** An audit source errored and was degraded to an empty feed (dimensioned by
 * source) — by design the feed never blanks, but a persistent non-zero value means
 * a source (CloudTrail / the stored ledger) is failing and warrants a look. */
export const METRIC_AUDIT_SOURCE_DEGRADED = "audit.source.degraded";

// Fleet gauges (emitted once per reconciler sweep).
export const METRIC_FLEET_TOTAL = "fleet.workspaces.total";
export const METRIC_FLEET_RUNNING = "fleet.workspaces.running";
export const METRIC_FLEET_STOPPED = "fleet.workspaces.stopped";
/** Running + idle (i.e. consuming compute right now). */
export const METRIC_FLEET_ACTIVE = "fleet.workspaces.active";
/** Priced fleet total (USD) at sweep time. */
export const METRIC_FLEET_COST_USD = "fleet.cost.usd";

// Quota gauges (emitted on a workspace create attempt, dimensioned by role).
/** Fraction of a user's per-role workspace quota in use (0 when unlimited). */
export const METRIC_QUOTA_UTILIZATION = "quota.utilization";
/** A create rejected because the per-role workspace quota was reached. */
export const METRIC_QUOTA_DENIED = "quota.denied";

/** Sink that drops every metric — the default when no real sink is wired. */
export class NoopMetricSink implements MetricSink {
  count(): void {
    /* no-op */
  }
  gauge(): void {
    /* no-op */
  }
  timing(): void {
    /* no-op */
  }
}

/** One metric recorded by `InMemoryMetricSink`. */
export interface RecordedMetric {
  readonly kind: "count" | "gauge" | "timing";
  readonly name: string;
  readonly value: number;
  readonly dimensions?: MetricDimensions;
}

/** Records metrics in memory for assertions in tests. */
export class InMemoryMetricSink implements MetricSink {
  readonly recorded: RecordedMetric[] = [];

  count(name: string, value = 1, dimensions?: MetricDimensions): void {
    this.push("count", name, value, dimensions);
  }
  gauge(name: string, value: number, dimensions?: MetricDimensions): void {
    this.push("gauge", name, value, dimensions);
  }
  timing(name: string, milliseconds: number, dimensions?: MetricDimensions): void {
    this.push("timing", name, milliseconds, dimensions);
  }

  private push(
    kind: RecordedMetric["kind"],
    name: string,
    value: number,
    dimensions?: MetricDimensions,
  ): void {
    this.recorded.push({ kind, name, value, ...(dimensions === undefined ? {} : { dimensions }) });
  }
}
