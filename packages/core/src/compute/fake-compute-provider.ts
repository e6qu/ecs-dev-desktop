// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import type { ComputeProvider, ComputeTask, RunTaskInput, TaskId } from "./compute-provider";

/** In-memory ComputeProvider for unit/integration tests. */
export class FakeComputeProvider implements ComputeProvider {
  private readonly running = new Map<TaskId, RunTaskInput>();

  async runTask(input: RunTaskInput): Promise<ComputeTask> {
    const id = `task-${randomUUID()}`;
    this.running.set(id, input);
    return { id };
  }

  async stopTask(taskId: TaskId): Promise<void> {
    this.running.delete(taskId);
  }

  /** Test helper: is a task currently running? */
  isRunning(taskId: TaskId): boolean {
    return this.running.has(taskId);
  }
}
