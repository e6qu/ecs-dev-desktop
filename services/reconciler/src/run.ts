// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reconciler entrypoint: reads environment variables, wires real adapters,
 * runs one full maintenance sweep, and exits. The ECS task definition's
 * `command` points at this file (compiled to dist/run.js).
 *
 * Required env: DYNAMODB_TABLE, ECS_CLUSTER, ECS_SUBNETS, ECS_EBS_ROLE_ARN.
 * Optional env read by the SDK adapters: AWS_REGION, AWS_ENDPOINT_URL,
 * DYNAMODB_ENDPOINT — same as the rest of the platform.
 * Optional tuning (DO_NEXT decision #4 knobs; defaults in @edd/core):
 * EDD_IDLE_THRESHOLD_MS, EDD_SNAPSHOT_INTERVAL_MS, EDD_EARLY_SNAPSHOT_INTERVAL_MS,
 * EDD_EARLY_SESSION_MS, EDD_GC_GRACE_MS, EDD_PROVISIONING_TIMEOUT_MS.
 */
import { metricSinkFromEnv } from "@edd/cloudwatch-metrics";
import { EcsComputeProvider } from "@edd/compute-ecs";
import {
  CostService,
  StoredAuditSource,
  StoredCostRollupStore,
  WorkspaceService,
} from "@edd/control-plane";
import { COST_ROLLUP_CADENCE_MS, workspacePricing, workspaceSizing } from "@edd/config";
import {
  createLogger,
  isoTimestamp,
  tallyWorkspaceStates,
  METRIC_FLEET_ACTIVE,
  METRIC_FLEET_COST_USD,
  METRIC_FLEET_RUNNING,
  METRIC_FLEET_STOPPED,
  METRIC_FLEET_TOTAL,
  METRIC_RECONCILER_DRIFT_LOST,
  METRIC_RECONCILER_FAILED,
  METRIC_RECONCILER_GC_DELETED,
  METRIC_RECONCILER_GC_FAILED,
  METRIC_RECONCILER_PROVISIONING_RECOVERED,
  METRIC_RECONCILER_TASKS_REAPED,
  METRIC_RECONCILER_TASKS_REAP_FAILED,
  METRIC_RECONCILER_TASKDEFS_PRUNED,
  METRIC_RECONCILER_TASKDEFS_PRUNE_FAILED,
  METRIC_RECONCILER_QUOTA_DRIFT_CORRECTED,
  METRIC_RECONCILER_SKIPPED,
  METRIC_RECONCILER_RECOVERED,
  METRIC_RECONCILER_DELETIONS_FINISHED,
  METRIC_RECONCILER_DELETIONS_FAILED,
  METRIC_RECONCILER_SNAPSHOT_LOST,
  METRIC_RECONCILER_ERROR_GAUGE,
  METRIC_RECONCILER_DELETING_GAUGE,
  METRIC_RECONCILER_SNAPSHOTTED,
  METRIC_RECONCILER_STOPPED,
  METRIC_RECONCILER_SWEEP,
  systemClock,
} from "@edd/core";
import {
  createDynamoClient,
  makeAuditEventEntity,
  makeCostRollupEntity,
  makeOwnerWorkspaceCountEntity,
  makeReconcilerHeartbeatEntity,
  makeWorkspaceEntity,
  RECONCILER_HEARTBEAT_ID,
} from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";

import { Reconciler } from "./index.js";

const table = process.env.DYNAMODB_TABLE;
if (!table) throw new Error("DYNAMODB_TABLE is required");

/** Optional positive-number env knob; invalid values fail loudly (§6.5). */
function tuningMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds: ${raw}`);
  }
  return value;
}

const idleThresholdMs = tuningMs("EDD_IDLE_THRESHOLD_MS");
const snapshotIntervalMs = tuningMs("EDD_SNAPSHOT_INTERVAL_MS");
const earlySnapshotIntervalMs = tuningMs("EDD_EARLY_SNAPSHOT_INTERVAL_MS");
const earlySessionMs = tuningMs("EDD_EARLY_SESSION_MS");
const convergeBudget = tuningMs("EDD_CONVERGE_BUDGET");
const gcGraceMs = tuningMs("EDD_GC_GRACE_MS");
const provisioningTimeoutMs = tuningMs("EDD_PROVISIONING_TIMEOUT_MS");

const dynamo = createDynamoClient();
const storage = Ec2StorageProvider.fromEnv();
const compute = EcsComputeProvider.fromEnv();
const auditEntity = makeAuditEventEntity(dynamo, table);
const service = new WorkspaceService({
  workspaces: makeWorkspaceEntity(dynamo, table),
  storage,
  compute,
  clock: systemClock,
  // Reconciler-driven scale-to-zero + drift stops are recorded to the same
  // first-class ledger as user actions (atomically with the transition), so the
  // cost model accounts for them.
  audit: auditEntity,
  // The reconciler is what hard-deletes records (finishDeletions), so it MUST carry
  // the per-owner counter — otherwise the quota counter increments on create (web app)
  // but never decrements, drifting up until every owner is permanently at their cap.
  ownerCounts: makeOwnerWorkspaceCountEntity(dynamo, table),
});
const heartbeat = makeReconcilerHeartbeatEntity(dynamo, table);
// Cost at config-default rates (live AWS pricing is a web-app opt-in) — enough to
// emit a fleet spend gauge from the sweep.
const cost = new CostService({
  audit: new StoredAuditSource({ events: auditEntity, clock: systemClock }),
  workspaces: service,
  clock: systemClock,
  pricing: workspacePricing(),
  sizing: workspaceSizing(),
  rollups: new StoredCostRollupStore(makeCostRollupEntity(dynamo, table)),
});
const log = createLogger({
  service: "reconciler",
  clock: systemClock,
  write: (line) => void process.stdout.write(`${line}\n`),
});
const metrics = metricSinkFromEnv();

const reconciler = new Reconciler({
  service,
  storage,
  // Enables the orphan-task reaper (self-heals workspace tasks with no record).
  compute,
  clock: systemClock,
  // Surface best-effort GC delete + orphan-task stop failures loudly, per resource.
  logger: log,
  ...(idleThresholdMs === undefined ? {} : { idleThresholdMs }),
  ...(snapshotIntervalMs === undefined ? {} : { snapshotIntervalMs }),
  ...(earlySnapshotIntervalMs === undefined ? {} : { earlySnapshotIntervalMs }),
  ...(earlySessionMs === undefined ? {} : { earlySessionMs }),
  ...(convergeBudget === undefined ? {} : { convergeBudget }),
  ...(gcGraceMs === undefined ? {} : { gcGraceMs }),
  ...(provisioningTimeoutMs === undefined ? {} : { provisioningTimeoutMs }),
});

try {
  const result = await reconciler.runMaintenance();

  // Per-action metrics (CloudWatch EMF on AWS) — the sweep's effect over time.
  metrics.count(METRIC_RECONCILER_SWEEP);
  metrics.count(METRIC_RECONCILER_PROVISIONING_RECOVERED, result.provisioning.recovered);
  metrics.count(METRIC_RECONCILER_DRIFT_LOST, result.drift.lost);
  metrics.count(METRIC_RECONCILER_SNAPSHOT_LOST, result.storageDrift.lost);
  metrics.count(METRIC_RECONCILER_RECOVERED, result.recovered.acted);
  metrics.count(METRIC_RECONCILER_DELETIONS_FINISHED, result.deletions.acted);
  metrics.count(METRIC_RECONCILER_DELETIONS_FAILED, result.deletions.failed);
  metrics.count(METRIC_RECONCILER_STOPPED, result.idle.stopped);
  metrics.count(METRIC_RECONCILER_SNAPSHOTTED, result.snapshots.snapshotted);
  metrics.count(
    METRIC_RECONCILER_GC_DELETED,
    result.gc.volumesDeleted + result.gc.snapshotsDeleted,
  );
  metrics.count(METRIC_RECONCILER_GC_FAILED, result.gc.volumesFailed + result.gc.snapshotsFailed);
  metrics.count(METRIC_RECONCILER_TASKS_REAPED, result.tasks.reaped);
  metrics.count(METRIC_RECONCILER_TASKS_REAP_FAILED, result.tasks.failed);
  metrics.count(METRIC_RECONCILER_TASKDEFS_PRUNED, result.taskDefs.deregistered);
  metrics.count(METRIC_RECONCILER_TASKDEFS_PRUNE_FAILED, result.taskDefs.failed);
  metrics.count(METRIC_RECONCILER_QUOTA_DRIFT_CORRECTED, result.quotaDriftCorrected);
  metrics.count(
    METRIC_RECONCILER_SKIPPED,
    result.provisioning.skipped +
      result.drift.skipped +
      result.idle.skipped +
      result.snapshots.skipped,
  );

  // Structured, queryable per-sweep log (was a single untyped JSON line).
  log.info("maintenance sweep complete", {
    provisioningScanned: result.provisioning.scanned,
    provisioningRecovered: result.provisioning.recovered,
    driftScanned: result.drift.scanned,
    driftLost: result.drift.lost,
    idleScanned: result.idle.scanned,
    stopped: result.idle.stopped,
    snapshotted: result.snapshots.snapshotted,
    volumesDeleted: result.gc.volumesDeleted,
    snapshotsDeleted: result.gc.snapshotsDeleted,
    gcFailed: result.gc.volumesFailed + result.gc.snapshotsFailed,
    tasksScanned: result.tasks.scanned,
    tasksReaped: result.tasks.reaped,
    tasksReapFailed: result.tasks.failed,
    taskDefsPruned: result.taskDefs.deregistered,
    taskDefsPruneFailed: result.taskDefs.failed,
    quotaDriftCorrected: result.quotaDriftCorrected,
    skipped:
      result.provisioning.skipped +
      result.drift.skipped +
      result.idle.skipped +
      result.snapshots.skipped,
  });

  // Heartbeat FIRST: the sweep above completed, and that — not the gauge/cost steps
  // below — is the fact the Health board's reconciler-staleness check records. Gating
  // the heartbeat behind a flaky `cost.report()`/gauge would make a healthy reconciler
  // report `degraded`. Its own try/catch so a heartbeat hiccup can't fail a good sweep.
  try {
    await heartbeat
      .put({ id: RECONCILER_HEARTBEAT_ID, lastRunAt: isoTimestamp(systemClock.now()) })
      .go();
  } catch (err) {
    log.warn("reconciler heartbeat write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Post-sweep gauges (best-effort, separately): fleet gauges + a priced spend gauge.
  // A gauge/cost hiccup must not turn a good sweep into a failure — and must not block
  // the heartbeat (above), which is why this is its own try after the heartbeat.
  try {
    const stats = tallyWorkspaceStates((await service.list()).map((w) => w.state));
    metrics.gauge(METRIC_FLEET_TOTAL, stats.total);
    metrics.gauge(METRIC_FLEET_RUNNING, stats.byState.running);
    metrics.gauge(METRIC_FLEET_STOPPED, stats.byState.stopped);
    metrics.gauge(METRIC_FLEET_ACTIVE, stats.active);
    // Convergence-health gauges: workspaces that couldn't move forward (error) or are
    // mid-teardown (deleting). A sustained non-zero error gauge is the "needs a human"
    // signal (the alarm in alarms.tf watches it).
    metrics.gauge(METRIC_RECONCILER_ERROR_GAUGE, stats.byState.error);
    metrics.gauge(METRIC_RECONCILER_DELETING_GAUGE, stats.byState.deleting);
    // Keep the cost checkpoints fresh on a cadence so this gauge's report() — and the
    // admin /costs route — stay O(recent) instead of full-scanning the whole ledger.
    await cost.rollupIfStale(COST_ROLLUP_CADENCE_MS);
    metrics.gauge(METRIC_FLEET_COST_USD, (await cost.report()).total.totalUsd);
  } catch (err) {
    log.warn("post-sweep observability step failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
} catch (err) {
  metrics.count(METRIC_RECONCILER_FAILED);
  log.error("maintenance sweep failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
}
