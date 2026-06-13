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
 * EDD_IDLE_THRESHOLD_MS, EDD_SNAPSHOT_INTERVAL_MS, EDD_GC_GRACE_MS.
 */
import { EcsComputeProvider } from "@edd/compute-ecs";
import { WorkspaceService } from "@edd/control-plane";
import { systemClock } from "@edd/core";
import { createDynamoClient, makeAuditEventEntity, makeWorkspaceEntity } from "@edd/db";
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
const gcGraceMs = tuningMs("EDD_GC_GRACE_MS");

const dynamo = createDynamoClient();
const storage = Ec2StorageProvider.fromEnv();
const compute = EcsComputeProvider.fromEnv();
const service = new WorkspaceService({
  workspaces: makeWorkspaceEntity(dynamo, table),
  storage,
  compute,
  clock: systemClock,
  // Reconciler-driven scale-to-zero + drift stops are recorded to the same
  // first-class ledger as user actions (atomically with the transition), so the
  // cost model accounts for them.
  audit: makeAuditEventEntity(dynamo, table),
});
const reconciler = new Reconciler({
  service,
  storage,
  clock: systemClock,
  ...(idleThresholdMs === undefined ? {} : { idleThresholdMs }),
  ...(snapshotIntervalMs === undefined ? {} : { snapshotIntervalMs }),
  ...(gcGraceMs === undefined ? {} : { gcGraceMs }),
});

const result = await reconciler.runMaintenance();
process.stdout.write(JSON.stringify(result) + "\n");
