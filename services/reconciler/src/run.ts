// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reconciler entrypoint: reads environment variables, wires real adapters,
 * runs one full maintenance sweep, and exits. The ECS task definition's
 * `command` points at this file (compiled to dist/run.js).
 *
 * Required env: DYNAMODB_TABLE, ECS_CLUSTER, ECS_SUBNETS, ECS_EBS_ROLE_ARN.
 * Optional env read by the SDK adapters: AWS_REGION, AWS_ENDPOINT_URL,
 * DYNAMODB_ENDPOINT — same as the rest of the platform.
 */
import { EcsComputeProvider } from "@edd/compute-ecs";
import { WorkspaceService } from "@edd/control-plane";
import { systemClock } from "@edd/core";
import { createDynamoClient, makeWorkspaceEntity } from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";

import { Reconciler } from "./index.js";

const table = process.env.DYNAMODB_TABLE;
if (!table) throw new Error("DYNAMODB_TABLE is required");

const dynamo = createDynamoClient();
const storage = Ec2StorageProvider.fromEnv();
const compute = EcsComputeProvider.fromEnv();
const service = new WorkspaceService({
  workspaces: makeWorkspaceEntity(dynamo, table),
  storage,
  compute,
  clock: systemClock,
});
const reconciler = new Reconciler({ service, storage, clock: systemClock });

const result = await reconciler.runMaintenance();
process.stdout.write(JSON.stringify(result) + "\n");
