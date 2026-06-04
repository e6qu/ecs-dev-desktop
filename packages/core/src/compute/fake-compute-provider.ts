// SPDX-License-Identifier: AGPL-3.0-or-later
import { newTaskId, type TaskId, type VolumeId } from "../domain/ids";
import type { ComponentHealth } from "../observability/health";
import type { StorageProvider } from "../storage/storage-provider";
import type { ComputeProvider, ComputeTask, RunTaskInput } from "./compute-provider";

/**
 * In-memory ComputeProvider for tests. Models ECS-managed EBS: `runTask` creates
 * the task's volume through the {@link StorageProvider} (hydrating from a snapshot
 * on wake) and `stopTask` releases it — mirroring how Fargate manages a task's
 * EBS volume.
 */
export class FakeComputeProvider implements ComputeProvider {
  private readonly volumes = new Map<TaskId, VolumeId>();

  constructor(private readonly storage: StorageProvider) {}

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const volume = await this.storage.createVolume(
      input.fromSnapshot === undefined ? undefined : { fromSnapshot: input.fromSnapshot },
    );
    const id = newTaskId();
    this.volumes.set(id, volume.id);
    return { id, volumeId: volume.id };
  }

  async stopTask(taskId: TaskId): Promise<void> {
    const volumeId = this.volumes.get(taskId);
    if (volumeId !== undefined) {
      await this.storage.deleteVolume(volumeId);
      this.volumes.delete(taskId);
    }
  }

  health(): Promise<ComponentHealth> {
    return Promise.resolve({
      component: "compute",
      status: "ok",
      detail: "in-memory fake (local)",
    });
  }

  /** Test helper: is a task currently running? */
  isRunning(taskId: TaskId): boolean {
    return this.volumes.has(taskId);
  }
}
