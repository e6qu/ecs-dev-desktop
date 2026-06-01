// SPDX-License-Identifier: AGPL-3.0-or-later
import { FakeComputeProvider, FakeStorageProvider, systemClock } from "@edd/core";
import { WorkspaceService } from "@edd/control-plane";
import { createDynamoClient, makeWorkspaceEntity } from "@edd/db";

/**
 * Process-wide control plane. Persistence (DynamoDB) is real; storage and
 * compute use the in-process fakes until the real EBS/ECS adapters land
 * (Phase 1). Built lazily so route modules import without side effects.
 */
let instance: Promise<WorkspaceService> | undefined;

export function getControlPlane(): Promise<WorkspaceService> {
  instance ??= build();
  return instance;
}

async function build(): Promise<WorkspaceService> {
  const client = createDynamoClient();
  const table = process.env.DYNAMODB_TABLE ?? "ecs-dev-desktop";
  return new WorkspaceService({
    workspaces: makeWorkspaceEntity(client, table),
    storage: await FakeStorageProvider.create(),
    compute: new FakeComputeProvider(),
    clock: systemClock,
  });
}
