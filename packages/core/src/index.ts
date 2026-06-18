// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit public API for @edd/core. No wildcard re-exports: the surface is
// deliberate and reviewable, and internals (e.g. the `brand` primitive) stay
// private. (See AGENTS.md §6.1.)

// Domain ids (branded types + smart constructors + generators).
export type {
  BaseImage,
  BaseImageId,
  Email,
  IsoTimestamp,
  OwnerId,
  SnapshotId,
  SshKeyFingerprint,
  SshKeyId,
  SshPublicKey,
  TaskId,
  VolumeId,
  WorkspaceId,
} from "./domain/ids";
export {
  baseImage,
  baseImageId,
  email,
  isoTimestamp,
  newBaseImageId,
  newSnapshotId,
  newSshKeyId,
  newTaskId,
  newVolumeId,
  newWorkspaceId,
  ownerId,
  snapshotId,
  sshKeyFingerprint,
  sshKeyId,
  sshPublicKey,
  taskId,
  volumeId,
  workspaceId,
} from "./domain/ids";

// Compile-time exhaustiveness guard.
export { assertNever } from "./assert-never";

// Result type (errors as data) + domain error union (the typed failure channel).
export type { Err, Ok, Result } from "./result";
export { andThen, err, isErr, isOk, map, mapErr, ok, unwrap } from "./result";
export type { DomainError, DomainErrorKind } from "./domain/errors";
export {
  conflictError,
  domainErrorMessage,
  invalidError,
  notFoundError,
  unavailableError,
} from "./domain/errors";

// Domain constants.
export {
  DEFAULT_AUDIT_FEED_LIMIT,
  DEFAULT_GC_GRACE_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_RECONCILER_STALE_MS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  ID_PREFIX,
} from "./domain/constants";

// Workspace domain object + pure lifecycle functions (functional core).
export type { ProvisionParams, Workspace } from "./domain/workspace";
export {
  assertTerminable,
  markActivity,
  markWaking,
  markProvisioned,
  markStopped,
  provision,
  markTaskLost,
  recordSnapshot,
} from "./domain/workspace";

// Per-workspace proxy authorization (pure): host→id + access decision.
export type { WorkspaceAccessInput } from "./domain/proxy-authz";
export { decideWorkspaceAccess, workspaceIdFromHost } from "./domain/proxy-authz";

// Per-role workspace quota gate (pure).
export { withinWorkspaceQuota } from "./domain/quota";

// Base-image catalog domain object + pure functions (functional core).
export type {
  BaseImageEntry,
  BaseImagePatch,
  ProvisionBaseImageParams,
} from "./domain/base-image-catalog";
export {
  applyBaseImagePatch,
  findEnabledImage,
  provisionBaseImage,
} from "./domain/base-image-catalog";

// Lifecycle state machine.
export type { WorkspaceEvent, WorkspaceState } from "./lifecycle/workspace-state-machine";
export { can, transition } from "./lifecycle/workspace-state-machine";

// Connect-time wake decision (wake-on-connect).
export type { ConnectAction } from "./lifecycle/connect";
export { planConnect } from "./lifecycle/connect";

// Storage port + fake + contract.
export type {
  Snapshot,
  SnapshotRef,
  StorageProvider,
  Volume,
  VolumeRef,
} from "./storage/storage-provider";
export { FakeStorageProvider } from "./storage/fake-storage-provider";
// NB: storageProviderContract is intentionally NOT re-exported — it imports
// `vitest`, so exposing it here would drag the test runner into every runtime
// consumer (e.g. the Next app). Tests import it directly by relative path.

// Maintenance functional core (orphan GC + scheduled-snapshot decisions).
export type { ReferencedStorage, SnapshotCandidate } from "./maintenance/select";
export {
  selectDueForSnapshot,
  selectOrphanSnapshots,
  selectOrphanTasks,
  selectOrphanVolumes,
} from "./maintenance/select";

// Compute port + fake.
export type {
  ClusterInfo,
  ComputeProvider,
  ComputeTask,
  RunTaskInput,
  TaskLiveness,
  WorkspaceTaskRef,
} from "./compute/compute-provider";
export type { FakeComputeConfig } from "./compute/fake-compute-provider";
export { FakeComputeProvider } from "./compute/fake-compute-provider";

// Clock.
export type { Clock } from "./clock";
export { fixedClock, systemClock } from "./clock";

// Observability — health roll-up (admin Health board).
export type { ComponentHealth, HealthReport, HealthStatus } from "./observability/health";
export { summarizeHealth, reconcilerHealthFromHeartbeat } from "./observability/health";

// Observability — system topology (admin Infrastructure view).
export type {
  Topology,
  TopologyEdge,
  TopologyKind,
  TopologyNode,
  TopologyNodeStatus,
} from "./observability/topology";
export { SYSTEM_TOPOLOGY, overlayTopologyHealth } from "./observability/topology";

// Observability — derived workspace lifecycle timeline (admin Inspect).
export type { TimelineEvent, WorkspaceTimelineInput } from "./observability/timeline";
export { deriveWorkspaceTimeline } from "./observability/timeline";

// Observability — workspace fleet stats (admin Overview).
export type { WorkspaceStats } from "./observability/stats";
export { tallyWorkspaceStates } from "./observability/stats";

// Observability — derived audit feed (admin Logs/Audit; CloudTrail on AWS).
export type { AuditEvent, AuditSource, FleetAuditInput } from "./observability/audit";
export { deriveFleetAudit } from "./observability/audit";

// Observability — metric emission port (CloudWatch EMF on AWS; no-op locally).
export type { MetricSink, MetricDimensions, RecordedMetric } from "./observability/metrics";
export {
  NoopMetricSink,
  InMemoryMetricSink,
  EDD_METRIC_NAMESPACE,
  METRIC_WORKSPACE_WAKE_LATENCY_MS,
  METRIC_RECONCILER_SWEEP,
  METRIC_RECONCILER_FAILED,
  METRIC_RECONCILER_STOPPED,
  METRIC_RECONCILER_SNAPSHOTTED,
  METRIC_RECONCILER_DRIFT_LOST,
  METRIC_RECONCILER_GC_DELETED,
  METRIC_RECONCILER_GC_FAILED,
  METRIC_RECONCILER_TASKS_REAPED,
  METRIC_RECONCILER_TASKS_REAP_FAILED,
  METRIC_RECONCILER_SKIPPED,
  METRIC_API_REQUEST,
  METRIC_API_LATENCY_MS,
  METRIC_API_ERROR,
  METRIC_FLEET_TOTAL,
  METRIC_FLEET_RUNNING,
  METRIC_FLEET_STOPPED,
  METRIC_FLEET_ACTIVE,
  METRIC_FLEET_COST_USD,
  METRIC_QUOTA_UTILIZATION,
  METRIC_QUOTA_DENIED,
} from "./observability/metrics";

// Observability — cost model (admin Costs; prices the lifecycle audit ledger).
export type {
  BillingIntervals,
  BillingState,
  CostBreakdown,
  FleetCostReport,
  Interval,
  Pricing,
  SessionCost,
  UserCost,
  WorkspaceCostInput,
  WorkspaceSizing,
} from "./observability/cost";
export {
  aggregateFleetCost,
  clipIntervals,
  computeFleetCost,
  deriveBillingIntervals,
  deriveBillingState,
  priceDurations,
  priceIntervals,
  relativeWindow,
  resumeBilling,
} from "./observability/cost";

// Observability — log streams (admin Logs; CloudWatch on AWS).
export type {
  LogLevel,
  LogLine,
  LogReadFilter,
  LogSource,
  LogStream,
  LogStreamResult,
} from "./observability/logs";
export { auditToLogLines } from "./observability/logs";

// Observability — structured (JSON) logging for the imperative shell.
export type {
  LogFields,
  LogFieldValue,
  LoggerDeps,
  StructuredLogger,
} from "./observability/logger";
export { createLogger, formatLogLine } from "./observability/logger";

// SSH: workspace principal derivation.
export {
  fingerprintPublicKey,
  isWorkspaceLabel,
  sshKeyType,
  workspacePrincipal,
  workspaceSshHost,
} from "./domain/ssh";
