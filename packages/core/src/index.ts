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

// Domain constants.
export {
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
export { can, InvalidTransitionError, transition } from "./lifecycle/workspace-state-machine";

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
export type { ComputeProvider, ComputeTask, RunTaskInput } from "./compute/compute-provider";
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
