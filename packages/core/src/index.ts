// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit public API for @edd/core. No wildcard re-exports: the surface is
// deliberate and reviewable, and internals (e.g. the `brand` primitive) stay
// private. (See AGENTS.md §6.1.)

// Domain ids (branded types + smart constructors + generators).
export type {
  BaseImage,
  IsoTimestamp,
  OwnerId,
  SnapshotId,
  TaskId,
  VolumeId,
  WorkspaceId,
} from "./domain/ids";
export {
  baseImage,
  isoTimestamp,
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
export { DEFAULT_IDLE_THRESHOLD_MS, ID_PREFIX } from "./domain/constants";

// Workspace domain object + pure lifecycle functions (functional core).
export type { ProvisionParams, Workspace } from "./domain/workspace";
export {
  assertTerminable,
  markStarted,
  markStopped,
  provision,
  recordSnapshot,
} from "./domain/workspace";

// Lifecycle state machine.
export type { WorkspaceEvent, WorkspaceState } from "./lifecycle/workspace-state-machine";
export { can, InvalidTransitionError, transition } from "./lifecycle/workspace-state-machine";

// Storage port + fake + contract.
export type { Snapshot, StorageProvider, Volume } from "./storage/storage-provider";
export { FakeStorageProvider } from "./storage/fake-storage-provider";
export { storageProviderContract } from "./storage/storage-provider-contract";

// Compute port + fake.
export type { ComputeProvider, ComputeTask, RunTaskInput } from "./compute/compute-provider";
export { FakeComputeProvider } from "./compute/fake-compute-provider";

// Clock.
export type { Clock } from "./clock";
export { fixedClock, systemClock } from "./clock";
