// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { newWorkspaceId, type BaseImage, type SnapshotId } from "../domain/ids";
import type { ComputeProvider } from "./compute-provider";

/**
 * The coordinates a {@link computeProviderContract} run needs: the provider under
 * test, a base image whose task stays alive long enough to observe, and a way to
 * mint a valid snapshot the provider can hydrate a fresh task from (the wake
 * path). The fake snapshots its injected in-memory storage; the real adapter
 * snapshots an EBS volume via `Ec2StorageProvider`. Built fresh per case so state
 * never leaks between assertions.
 */
export interface ComputeContractHarness {
  readonly compute: ComputeProvider;
  readonly baseImage: BaseImage;
  /** Produce a valid snapshot id this provider can hydrate a task from. */
  makeSnapshot(): Promise<SnapshotId>;
}

/**
 * Reusable contract for the ComputeProvider port. Both the in-memory fake (tier-1)
 * and the real `EcsComputeProvider` (container-mode e2e — the only tier where a
 * task actually reaches RUNNING) must pass this identical suite, which is what
 * keeps the fake's task-lifecycle and snapshot-hydration model honest against
 * real Fargate. It asserts the **lifecycle/state** contract (launch → running →
 * stop → stopped, fresh vs. snapshot-hydrated launch) — never volume *contents*,
 * which aren't expressible at the compute control-plane layer (AGENTS.md §6.8;
 * proven through the storage data-I/O contract and the real-AWS tier instead).
 */
export function computeProviderContract(
  name: string,
  makeHarness: () => Promise<ComputeContractHarness>,
): void {
  describe(`ComputeProvider contract: ${name}`, () => {
    it("launches a task with a managed volume and reports it running", async () => {
      const { compute, baseImage } = await makeHarness();
      const task = await compute.runTask({ workspaceId: newWorkspaceId(), baseImage });
      try {
        expect(task.volumeId).toBeTruthy();
        expect(await compute.taskState(task.id)).toBe("running");
      } finally {
        await compute.stopTask(task.id);
      }
    });

    it("releases the task on stop (taskState → stopped)", async () => {
      const { compute, baseImage } = await makeHarness();
      const task = await compute.runTask({ workspaceId: newWorkspaceId(), baseImage });
      await compute.stopTask(task.id);
      expect(await compute.taskState(task.id)).toBe("stopped");
    });

    it("hydrates a fresh task from a snapshot (the wake path)", async () => {
      const { compute, baseImage, makeSnapshot } = await makeHarness();
      const fromSnapshot = await makeSnapshot();
      const task = await compute.runTask({ workspaceId: newWorkspaceId(), baseImage, fromSnapshot });
      try {
        expect(task.volumeId).toBeTruthy();
        expect(await compute.taskState(task.id)).toBe("running");
      } finally {
        await compute.stopTask(task.id);
      }
    });
  });
}
