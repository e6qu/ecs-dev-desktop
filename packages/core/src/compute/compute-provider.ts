// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ComputeProvider — the port that abstracts running a workspace's container
 * task. The real adapter (ECS Fargate RunTask/StopTask) lands with the AWS
 * infra; a {@link FakeComputeProvider} backs unit/integration tests so the
 * control plane is exercisable without AWS.
 */
export type TaskId = string;

export interface ComputeTask {
  readonly id: TaskId;
}

export interface RunTaskInput {
  workspaceId: string;
  baseImage: string;
  volumeId: string;
}

export interface ComputeProvider {
  /** Launch a workspace task bound to a hydrated volume. */
  runTask(input: RunTaskInput): Promise<ComputeTask>;

  /** Stop and reap a running task. */
  stopTask(taskId: TaskId): Promise<void>;
}
