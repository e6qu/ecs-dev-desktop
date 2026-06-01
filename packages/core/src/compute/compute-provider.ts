// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImage, TaskId, VolumeId, WorkspaceId } from "../domain/ids";

/**
 * ComputeProvider — the port abstracting running a workspace's container task.
 * The real adapter (ECS Fargate RunTask/StopTask) lands with the AWS infra; a
 * {@link FakeComputeProvider} backs unit/integration tests so the control plane
 * is exercisable without AWS.
 */
export interface ComputeTask {
  readonly id: TaskId;
}

export interface RunTaskInput {
  workspaceId: WorkspaceId;
  baseImage: BaseImage;
  volumeId: VolumeId;
}

export interface ComputeProvider {
  /** Launch a workspace task bound to a hydrated volume. */
  runTask(input: RunTaskInput): Promise<ComputeTask>;

  /** Stop and reap a running task. */
  stopTask(taskId: TaskId): Promise<void>;
}
