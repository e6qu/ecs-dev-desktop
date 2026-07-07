// SPDX-License-Identifier: AGPL-3.0-or-later
import { CloudTrailAuditSource } from "@edd/cloudtrail-audit";
import { CloudWatchLogSource } from "@edd/cloudwatch-logs";
import { CloudWatchMetricReader } from "@edd/cloudwatch-metrics";
import { metricSinkFromEnv } from "@edd/cloudwatch-metrics";
import { EcsComputeProvider } from "@edd/compute-ecs";
import {
  evaluateConfigSync,
  FakeComputeProvider,
  FakeStorageProvider,
  systemClock,
  type ComponentHealth,
  type ConfigSyncReport,
  type DependencyStatus,
} from "@edd/core";
import { workspaceSizing } from "@edd/config";
import { iamPreflight } from "@edd/iam-preflight";

import { resolveWorkspacePricing } from "./aws-pricing";
import {
  CatalogService,
  CostService,
  DerivedAuditSource,
  DerivedLogSource,
  HealthService,
  InfrastructureService,
  SshKeyService,
  StoredAuditSource,
  StoredCostRollupStore,
  WorkspaceService,
} from "@edd/control-plane";
import {
  createDynamoClient,
  makeAuditEventEntity,
  makeOwnerWorkspaceCountEntity,
  makeBaseImageEntity,
  makeCostRollupEntity,
  makeReconcilerHeartbeatEntity,
  makeSshKeyEntity,
  makeSshKeyFingerprintEntity,
  makeWorkspaceEntity,
  pingTable,
  RECONCILER_HEARTBEAT_ID,
  TABLE,
} from "@edd/db";
import { Ec2StorageProvider } from "@edd/storage-ec2";

import { AGENT_SECRET_ENV, CONNECTION_SECRET_ENV } from "./constants";

/**
 * Process-wide control plane. Persistence is always real DynamoDB.
 * Storage + compute use the real EBS/ECS adapters when COMPUTE_PROVIDER=ecs and
 * the required ECS env vars are set; otherwise the in-process fakes are used
 * (dev / integration tests). Built lazily so route modules import side-effect-free.
 */
let instance: Promise<WorkspaceService> | undefined;
let catalog: CatalogService | undefined;
let sshKeys: SshKeyService | undefined;
let auditLog: StoredAuditSource | undefined;
let auditEvents: ReturnType<typeof makeAuditEventEntity> | undefined;
let ownerCounts: ReturnType<typeof makeOwnerWorkspaceCountEntity> | undefined;

/** The shared `auditEvent` entity over the single table. `WorkspaceService`
 * writes lifecycle events to it atomically with each transition; the audit log
 * + cost service read from it. */
function getAuditEntity(): ReturnType<typeof makeAuditEventEntity> {
  auditEvents ??= makeAuditEventEntity(createDynamoClient(), tableName());
  return auditEvents;
}

/** The shared per-owner workspace-count entity. `WorkspaceService` increments it
 * (guarded by the quota) atomically with each create and decrements it on delete —
 * so the per-user cap can't be raced past. */
function getOwnerCountEntity(): ReturnType<typeof makeOwnerWorkspaceCountEntity> {
  ownerCounts ??= makeOwnerWorkspaceCountEntity(createDynamoClient(), tableName());
  return ownerCounts;
}

/** The first-class, append-only audit log (actor-attributed control-plane
 * actions). Distinct from the derived fleet feed + CloudTrail. */
export function getAuditLog(): StoredAuditSource {
  auditLog ??= new StoredAuditSource({ events: getAuditEntity(), clock: systemClock });
  return auditLog;
}

export function tableName(): string {
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

/** Account-level SSH public keys over the same single table. Backs the
 * `/api/ssh-keys` routes and the gateway's connect-time authorize decision. */
export function getSshKeyService(): SshKeyService {
  sshKeys ??= new SshKeyService({
    keys: makeSshKeyEntity(createDynamoClient(), tableName()),
    fingerprints: makeSshKeyFingerprintEntity(createDynamoClient(), tableName()),
    clock: systemClock,
  });
  return sshKeys;
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
  if (useRealProviders()) return buildRealProviders();
  assertFakeProvidersAllowed();
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
 * App-level config-sync self-check: does the running control plane match its expected
 * configuration (real providers selected, the ECS/EBS + observability coordinates
 * present, DynamoDB + the ECS cluster reachable)? Pure evaluation in `@edd/core`; this
 * shell gathers `process.env` + the two live dependency signals from the Health board.
 */
export async function getConfigSyncReport(): Promise<ConfigSyncReport> {
  const report = await (await getHealthService()).report();
  const statusOf = (component: string): DependencyStatus => {
    const c = report.components.find((x) => x.component === component);
    if (c === undefined || c.status === "unknown") return "unknown";
    return c.status === "ok" ? "ok" : "down";
  };
  const { signal, identity } = await iamPreflight();
  return evaluateConfigSync({
    env: process.env,
    dynamodb: statusOf("dynamodb"),
    compute: statusOf("compute"),
    iam: signal,
    ...(identity !== null ? { iamIdentity: identity } : {}),
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

/** Per-workspace utilization/IOPS series: CloudWatch on AWS; null locally (the
 * monitoring view then shows an explicit "streams from CloudWatch on AWS" note,
 * mirroring the log source's behavior — §6.5, no silent empty). */
export function getMetricReader(): CloudWatchMetricReader | null {
  return process.env.LOG_PROVIDER === "cloudwatch" ? CloudWatchMetricReader.fromEnv() : null;
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
  const compute = EcsComputeProvider.fromEnv(
    process.env[AGENT_SECRET_ENV],
    process.env[CONNECTION_SECRET_ENV],
  );
  return { storage, compute };
}

/** The real EBS/ECS adapters are selected by `COMPUTE_PROVIDER=ecs`. */
function useRealProviders(): boolean {
  return process.env.COMPUTE_PROVIDER === "ecs";
}

/**
 * Whether falling back to the in-process fakes is permitted for this process. Pure
 * over the given env so it is unit-testable. Fakes are allowed only when this is
 * plainly a dev/test deployment: `NODE_ENV` is not `production`, the dev-auth shim is
 * on (`EDD_DEV_AUTH=1` — never set in prod, since it bypasses the real IdP), or an
 * explicit opt-in (`EDD_ALLOW_FAKE_PROVIDERS=1`) is set.
 */
export function fakeProvidersAllowed(env: Record<string, string | undefined>): boolean {
  return (
    env.NODE_ENV !== "production" ||
    env.EDD_DEV_AUTH === "1" ||
    env.EDD_ALLOW_FAKE_PROVIDERS === "1"
  );
}

/**
 * Fail loud rather than silently fall back to the in-process fakes in production
 * (§6.5). A prod deploy that forgot `COMPUTE_PROVIDER=ecs` would otherwise report
 * workspaces as "running" without ever launching ECS/EBS — a dangerous no-op. Call
 * before constructing any fake provider.
 */
function assertFakeProvidersAllowed(): void {
  if (!fakeProvidersAllowed(process.env)) {
    throw new Error(
      "Refusing to use in-process fake compute/storage in production: a misconfigured " +
        "deploy would report workspaces as running without launching ECS/EBS. Set " +
        "COMPUTE_PROVIDER=ecs to use the real adapters, or EDD_ALLOW_FAKE_PROVIDERS=1 to " +
        "explicitly opt into the fakes (dev/test only).",
    );
  }
}

async function build(): Promise<WorkspaceService> {
  const client = createDynamoClient();
  if (useRealProviders()) {
    const { storage, compute } = buildRealProviders();
    return new WorkspaceService({
      workspaces: makeWorkspaceEntity(client, tableName()),
      storage,
      compute,
      clock: systemClock,
      audit: getAuditEntity(),
      ownerCounts: getOwnerCountEntity(),
      // Wake cold-start latency → CloudWatch EMF when LOG_PROVIDER=cloudwatch.
      metrics: metricSinkFromEnv(),
    });
  }
  assertFakeProvidersAllowed();
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
    ownerCounts: getOwnerCountEntity(),
  });
}
