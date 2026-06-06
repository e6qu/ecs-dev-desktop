// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailAuditSource } from "@edd/cloudtrail-audit";
import { CloudWatchLogSource } from "@edd/cloudwatch-logs";
import { EcsComputeProvider } from "@edd/compute-ecs";
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
import { Ec2StorageProvider } from "@edd/storage-ec2";

/**
 * Process-wide control plane. Persistence is always real DynamoDB.
 * Storage + compute use the real EBS/ECS adapters when COMPUTE_PROVIDER=ecs and
 * the required ECS env vars are set; otherwise the in-process fakes are used
 * (dev / integration tests). Built lazily so route modules import side-effect-free.
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

/** Admin Health board service: real DynamoDB ping + the active providers. */
export async function getHealthService(): Promise<HealthService> {
  const client = createDynamoClient();
  const table = tableName();
  if (process.env.COMPUTE_PROVIDER === "ecs") {
    const { storage, compute } = buildRealProviders();
    return new HealthService({
      storage,
      compute,
      pingDatabase: () => pingTable(client, table),
      clock: systemClock,
    });
  }
  const storage = await FakeStorageProvider.create();
  return new HealthService({
    storage,
    compute: new FakeComputeProvider(storage),
    pingDatabase: () => pingTable(client, table),
    clock: systemClock,
  });
}

/** Admin audit feed: CloudTrail on AWS; derived from state locally. */
export function getAuditSource(): CloudTrailAuditSource | DerivedAuditSource {
  if (process.env.AUDIT_PROVIDER === "cloudtrail") {
    return CloudTrailAuditSource.fromEnv();
  }
  return new DerivedAuditSource({
    workspaces: makeWorkspaceEntity(createDynamoClient(), tableName()),
  });
}

/** Admin log streams: CloudWatch on AWS; derived from state locally. */
export function getLogSource(): CloudWatchLogSource | DerivedLogSource {
  if (process.env.LOG_PROVIDER === "cloudwatch") {
    const appName = process.env.EDD_APP_NAME;
    if (appName === undefined || appName.length === 0)
      throw new Error("EDD_APP_NAME is required when LOG_PROVIDER=cloudwatch");
    return CloudWatchLogSource.fromEnv(appName);
  }
  return new DerivedLogSource({ audit: getAuditSource() });
}

function buildRealProviders(): { storage: Ec2StorageProvider; compute: EcsComputeProvider } {
  const storage = Ec2StorageProvider.fromEnv();
  const compute = EcsComputeProvider.fromEnv(process.env.EDD_AGENT_SECRET);
  return { storage, compute };
}

async function build(): Promise<WorkspaceService> {
  const client = createDynamoClient();
  if (process.env.COMPUTE_PROVIDER === "ecs") {
    const { storage, compute } = buildRealProviders();
    return new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, tableName()),
      storage,
      compute,
      clock: systemClock,
    });
  }
  const storage = await FakeStorageProvider.create();
  return new WorkspaceService({
    workspaces: makeWorkspaceEntity(client, tableName()),
    storage,
    compute: new FakeComputeProvider(storage),
    clock: systemClock,
  });
}
