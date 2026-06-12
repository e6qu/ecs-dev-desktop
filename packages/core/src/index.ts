// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit public API for @edd/core. No wildcard re-exports: the surface is
// deliberate and reviewable, and internals (e.g. the `brand` primitive) stay
// private. (See AGENTS.md §6.1.)

// Domain ids (branded types + smart constructors + generators).
export type {
  BaseImage,
  BaseImageId,
  IsoTimestamp,
  OwnerId,
  SnapshotId,
  TaskId,
  VolumeId,
  WorkspaceId,
} from "./domain/ids";
export {
  baseImage,
  baseImageId,
  isoTimestamp,
  newBaseImageId,
  newSnapshotId,
  newTaskId,
  newVolumeId,
  newWorkspaceId,
  ownerId,
  snapshotId,
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
export { conflictError, domainErrorMessage, invalidError, notFoundError } from "./domain/errors";

// Domain constants.
export {
  DEFAULT_AUDIT_FEED_LIMIT,
  DEFAULT_GC_GRACE_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  ID_PREFIX,
} from "./domain/constants";

// Workspace domain object + pure lifecycle functions (functional core).
export type { ProvisionParams, Workspace } from "./domain/workspace";
export {
  assertTerminable,
  markActivity,
  markStarted,
  markStopped,
  provision,
  markTaskLost,
  recordSnapshot,
} from "./domain/workspace";

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
  selectOrphanVolumes,
} from "./maintenance/select";

// Compute port + fake.
export type {
  ComputeProvider,
  ComputeTask,
  RunTaskInput,
  TaskLiveness,
} from "./compute/compute-provider";
export type { FakeComputeConfig } from "./compute/fake-compute-provider";
export { FakeComputeProvider } from "./compute/fake-compute-provider";

// Clock.
export type { Clock } from "./clock";
export { fixedClock, systemClock } from "./clock";

// Observability — health roll-up (admin Health board).
export type { ComponentHealth, HealthReport, HealthStatus } from "./observability/health";
export { summarizeHealth } from "./observability/health";

// Observability — derived workspace lifecycle timeline (admin Inspect).
export type { TimelineEvent, WorkspaceTimelineInput } from "./observability/timeline";
export { deriveWorkspaceTimeline } from "./observability/timeline";

// Observability — workspace fleet stats (admin Overview).
export type { WorkspaceStats } from "./observability/stats";
export { tallyWorkspaceStates } from "./observability/stats";

// Observability — derived audit feed (admin Logs/Audit; CloudTrail on AWS).
export type { AuditEvent, AuditSource, FleetAuditInput } from "./observability/audit";
export { deriveFleetAudit } from "./observability/audit";

// Observability — log streams (admin Logs; CloudWatch on AWS).
export type {
  LogLevel,
  LogLine,
  LogSource,
  LogStream,
  LogStreamResult,
} from "./observability/logs";
export { auditToLogLines } from "./observability/logs";

// SSH: workspace principal derivation.
export { workspacePrincipal } from "./domain/ssh";
