// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailAuditSource } from "@edd/cloudtrail-audit";
import { CloudWatchLogSource } from "@edd/cloudwatch-logs";
import { metricSinkFromEnv } from "@edd/cloudwatch-metrics";
import { EcsComputeProvider } from "@edd/compute-ecs";
import {
  FakeComputeProvider,
  FakeStorageProvider,
  systemClock,
  type ComponentHealth,
} from "@edd/core";
import { workspaceSizing } from "@edd/config";

import { resolveWorkspacePricing } from "./aws-pricing";
import {
  CatalogService,
  CostService,
  DerivedAuditSource,
  DerivedLogSource,
  HealthService,
  InfrastructureService,
  StoredAuditSource,
  StoredCostRollupStore,
  WorkspaceService,
} from "@edd/control-plane";
import {
  createDynamoClient,
  makeAuditEventEntity,
  makeBaseImageEntity,
  makeCostRollupEntity,
  makeReconcilerHeartbeatEntity,
  makeWorkspaceEntity,
  pingTable,
  RECONCILER_HEARTBEAT_ID,
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
let auditLog: StoredAuditSource | undefined;
let auditEvents: ReturnType<typeof makeAuditEventEntity> | undefined;

/** The shared `auditEvent` entity over the single table. `WorkspaceService`
 * writes lifecycle events to it atomically with each transition; the audit log
 * + cost service read from it. */
function getAuditEntity(): ReturnType<typeof makeAuditEventEntity> {
  auditEvents ??= makeAuditEventEntity(createDynamoClient(), tableName());
  return auditEvents;
}

/** The first-class, append-only audit log (actor-attributed control-plane
 * actions). Distinct from the derived fleet feed + CloudTrail. */
export function getAuditLog(): StoredAuditSource {
  auditLog ??= new StoredAuditSource({ events: getAuditEntity(), clock: systemClock });
  return auditLog;
}

function tableName(): string {
  return process.env.DYNAMODB_TABLE ?? TABLE;
}

export function getControlPlane(): Promise<WorkspaceService> {
  instance ??= build();
  return instance;
}

/** Admin Costs service: prices the lifecycle audit ledger at the configured
 * (us-east-1 on-demand default, env-overridable) rates + workspace sizing. */
export async function getCostService(): Promise<CostService> {
  return new CostService({
    audit: getAuditLog(),
    workspaces: await getControlPlane(),
    clock: systemClock,
    // Live AWS Price List rates for the region when EDD_AWS_PRICING=1, else the
    // configured rates (us-east-1 default, EDD_PRICE_*-overridable).
    pricing: await resolveWorkspacePricing(),
    sizing: workspaceSizing(),
    // Price from persisted checkpoints + the tail since them (O(recent)); falls
    // back to the exact full-ledger scan until `rollup()` first runs. Same GSI1 the
    // audit feed already uses — no table change.
    rollups: new StoredCostRollupStore(makeCostRollupEntity(createDynamoClient(), tableName())),
  });
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
/** Reads the reconciler's last-sweep heartbeat for the Health board (null if no
 * sweep has run yet). Same record the reconciler stamps each sweep. */
function reconcilerHeartbeatReader(
  client: ReturnType<typeof createDynamoClient>,
  table: string,
): () => Promise<{ lastRunAt: string } | null> {
  const entity = makeReconcilerHeartbeatEntity(client, table);
  return async () => {
    const r = await entity.get({ id: RECONCILER_HEARTBEAT_ID }).go();
    return r.data === null ? null : { lastRunAt: r.data.lastRunAt };
  };
}

/** The active storage + compute providers: the real EBS/ECS adapters under
 * COMPUTE_PROVIDER=ecs, else the in-process fakes (dev/integration). Shared by the
 * Health board and the Infrastructure view so both see the same backend. */
async function activeProviders(): Promise<{
  storage: Ec2StorageProvider | FakeStorageProvider;
  compute: EcsComputeProvider | FakeComputeProvider;
}> {
  if (process.env.COMPUTE_PROVIDER === "ecs") return buildRealProviders();
  const storage = await FakeStorageProvider.create();
  return { storage, compute: new FakeComputeProvider(storage) };
}

export async function getHealthService(): Promise<HealthService> {
  const client = createDynamoClient();
  const table = tableName();
  const { storage, compute } = await activeProviders();
  return new HealthService({
    storage,
    compute,
    pingDatabase: () => pingTable(client, table),
    reconcilerHeartbeat: reconcilerHeartbeatReader(client, table),
    clock: systemClock,
  });
}

/** Admin Infrastructure view: the Health board + live ECS cluster state + fleet
 * metrics + the component topology, sharing one compute backend. */
export async function getInfrastructureService(): Promise<InfrastructureService> {
  const client = createDynamoClient();
  const table = tableName();
  const { storage, compute } = await activeProviders();
  const health = new HealthService({
    storage,
    compute,
    pingDatabase: () => pingTable(client, table),
    reconcilerHeartbeat: reconcilerHeartbeatReader(client, table),
    clock: systemClock,
  });
  const cp = await getControlPlane();
  return new InfrastructureService({
    health,
    compute,
    listWorkspaceStates: async () => (await cp.list()).map((w) => w.state),
  });
}

/**
 * Readiness probe for the ALB target group: the control plane can serve traffic
 * only if its single DynamoDB table is reachable and ACTIVE. This is distinct from
 * `/api/healthz` liveness (process-is-up, drives the ECS container restart): a task
 * that can't reach its data store should be pulled from the load balancer, not
 * killed. Returns the table's `ComponentHealth` for the route to map to 200/503.
 */
export async function checkReadiness(): Promise<ComponentHealth> {
  return pingTable(createDynamoClient(), tableName());
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
      audit: getAuditEntity(),
      // Wake cold-start latency → CloudWatch EMF when LOG_PROVIDER=cloudwatch.
      metrics: metricSinkFromEnv(),
    });
  }
  const storage = await FakeStorageProvider.create();
  // The fake compute provider records no real ENI; e2e harnesses that pair the
  // fake control plane with a real sshd container set EDD_FAKE_SSH_HOST so
  // /connect-info returns a reachable host (config of the fake, not a sim branch).
  const fakeSshHost = process.env.EDD_FAKE_SSH_HOST;
  return new WorkspaceService({
    workspaces: makeWorkspaceEntity(client, tableName()),
    storage,
    compute: new FakeComputeProvider(
      storage,
      fakeSshHost !== undefined && fakeSshHost.length > 0 ? { sshHost: fakeSshHost } : {},
    ),
    clock: systemClock,
    audit: getAuditEntity(),
  });
}
