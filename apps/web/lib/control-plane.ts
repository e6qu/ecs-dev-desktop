// SPDX-License-Identifier: AGPL-3.0-or-later
import { FakeComputeProvider, FakeStorageProvider, systemClock } from "@edd/core";
import {
  CatalogService,
  DerivedAuditSource,
  DerivedLogSource,
  HealthService,
  WorkspaceService,
} from "@edd/control-plane";
import {
  createDynamoClient,
  makeBaseImageEntity,
  makeWorkspaceEntity,
  pingTable,
  TABLE,
} from "@edd/db";

/**
 * Process-wide control plane. Persistence (DynamoDB) is real; storage and
 * compute use the in-process fakes until the real EBS/ECS adapters land
 * (Phase 1). Built lazily so route modules import without side effects.
 */
let instance: Promise<WorkspaceService> | undefined;
let catalog: CatalogService | undefined;

function tableName(): string {
  return process.env.DYNAMODB_TABLE ?? TABLE;
}

export function getControlPlane(): Promise<WorkspaceService> {
  instance ??= build();
  return instance;
}

/** The admin base-image catalog over the same single table (sync — no fakes). */
export function getCatalog(): CatalogService {
  catalog ??= new CatalogService({
    baseImages: makeBaseImageEntity(createDynamoClient(), tableName()),
    clock: systemClock,
  });
  return catalog;
}

/** Admin Health board service: real DynamoDB ping + the (fake, until AWS) providers. */
export async function getHealthService(): Promise<HealthService> {
  const client = createDynamoClient();
  const table = tableName();
  const storage = await FakeStorageProvider.create();
  return new HealthService({
    storage,
    compute: new FakeComputeProvider(storage),
    pingDatabase: () => pingTable(client, table),
    clock: systemClock,
  });
}

/** Admin audit feed: derived from current workspace state (CloudTrail on AWS). */
export function getAuditSource(): DerivedAuditSource {
  return new DerivedAuditSource({
    workspaces: makeWorkspaceEntity(createDynamoClient(), tableName()),
  });
}

/** Admin log streams: control-plane derived now; reconciler/container on AWS. */
export function getLogSource(): DerivedLogSource {
  return new DerivedLogSource({ audit: getAuditSource() });
}

async function build(): Promise<WorkspaceService> {
  const client = createDynamoClient();
  const storage = await FakeStorageProvider.create();
  return new WorkspaceService({
    workspaces: makeWorkspaceEntity(client, tableName()),
    storage,
    compute: new FakeComputeProvider(storage),
    clock: systemClock,
  });
}
