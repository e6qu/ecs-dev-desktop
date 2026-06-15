// SPDX-License-Identifier: AGPL-3.0-or-later
import { newTaskId, type TaskId, type VolumeId } from "../domain/ids";
import type { ComponentHealth } from "../observability/health";
import type { StorageProvider } from "../storage/storage-provider";
import type {
  ClusterInfo,
  ComputeProvider,
  ComputeTask,
  RunTaskInput,
  TaskLiveness,
} from "./compute-provider";

/**
 * In-memory ComputeProvider for tests. Models ECS-managed EBS: `runTask` creates
 * the task's volume through the {@link StorageProvider} (hydrating from a snapshot
 * on wake) and `stopTask` releases it — mirroring how Fargate manages a task's
 * EBS volume.
 */
export interface FakeComputeConfig {
  /** Fixed SSH host returned in every ComputeTask (e.g. "localhost" in tests). */
  sshHost?: string;
}

export class FakeComputeProvider implements ComputeProvider {
  private readonly volumes = new Map<TaskId, VolumeId>();
  private readonly config: FakeComputeConfig;

  constructor(
    private readonly storage: StorageProvider,
    config: FakeComputeConfig = {},
  ) {
    this.config = config;
  }

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const volume = await this.storage.createVolume(
      input.fromSnapshot === undefined ? undefined : { fromSnapshot: input.fromSnapshot },
    );
    const id = newTaskId();
    this.volumes.set(id, volume.id);
    return { id, volumeId: volume.id, sshHost: this.config.sshHost };
  }

  async stopTask(taskId: TaskId): Promise<void> {
    const volumeId = this.volumes.get(taskId);
    if (volumeId !== undefined) {
      await this.storage.deleteVolume(volumeId);
      this.volumes.delete(taskId);
    }
  }

  /** A task is live exactly while its managed volume is still attached. */
  taskState(taskId: TaskId): Promise<TaskLiveness> {
    return Promise.resolve(this.volumes.has(taskId) ? "running" : "stopped");
  }

  health(): Promise<ComponentHealth> {
    return Promise.resolve({
      component: "compute",
      status: "ok",
      detail: "in-memory fake (local)",
    });
  }

  /** Cluster state for the admin Infrastructure view: the in-memory equivalent of
   * a real ECS cluster — running tasks = currently-attached managed volumes. No
   * fabricated cloud metrics; just what this provider actually holds. */
  clusterInfo(): Promise<ClusterInfo> {
    return Promise.resolve({
      name: "local",
      status: "local",
      runningTasks: this.volumes.size,
      pendingTasks: 0,
      activeServices: 0,
      registeredContainerInstances: 0,
    });
  }

  /** Test helper: is a task currently running? */
  isRunning(taskId: TaskId): boolean {
    return this.volumes.has(taskId);
  }
}
