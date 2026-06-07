// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImage, SnapshotId, TaskId, VolumeId, WorkspaceId } from "../domain/ids";
import type { ComponentHealth } from "../observability/health";

/**
 * ComputeProvider — runs a workspace's container task on Fargate with an
 * ECS-**managed** EBS volume. `runTask` creates that volume (hydrating it from a
 * snapshot when waking) and returns its id; the volume's create/release lifecycle
 * is owned here, while the {@link StorageProvider} handles snapshots, restore
 * lifecycle, and GC on that id. The real adapter is ECS Fargate RunTask/StopTask;
 * a {@link FakeComputeProvider} backs unit/integration tests without AWS.
 */
export interface ComputeTask {
  readonly id: TaskId;
  /** The ECS-managed EBS volume created for (and released with) the task. */
  readonly volumeId: VolumeId;
  /** Private IP of the task's ENI (awsvpc). The SSH gateway forwards to this address. Undefined when the compute backend doesn't expose it (e.g. the fake). */
  readonly sshHost?: string;
}

export interface RunTaskInput {
  workspaceId: WorkspaceId;
  baseImage: BaseImage;
  /** Hydrate the managed volume from this snapshot (wake); omit for a fresh volume. */
  fromSnapshot?: SnapshotId;
}

export interface ComputeProvider {
  /** Launch a task with a fresh or snapshot-hydrated managed EBS volume. */
  runTask(input: RunTaskInput): Promise<ComputeTask>;

  /** Stop the task; the platform releases its managed EBS volume. */
  stopTask(taskId: TaskId): Promise<void>;

  /** Dependency health (admin Health board). Real adapters do a live check; absent
   * ⇒ reported as `unknown` (real check available on AWS). */
  health?(): Promise<ComponentHealth>;
}
