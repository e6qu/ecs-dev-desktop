// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { baseImage, workspaceId } from "../domain/ids";
import { FakeStorageProvider } from "../storage/fake-storage-provider";
import { computeProviderContract } from "./compute-provider-contract";
import { FakeComputeProvider } from "./fake-compute-provider";

const RESOURCES = { cpuUnits: 512, memoryMiB: 2048, volumeGiB: 8 } as const;

// The shared port contract: the fake must model the same task-lifecycle +
// snapshot-hydration behaviour the real EcsComputeProvider proves in container-mode
// e2e — so a divergence in the fake (which most unit tests run against) is caught here.
computeProviderContract("FakeComputeProvider", async () => {
  const storage = await FakeStorageProvider.create();
  return {
    compute: new FakeComputeProvider(storage),
    baseImage: baseImage("golden/node:20"),
    // Snapshot the SAME storage the fake compute hydrates from, so the wake path
    // (createVolume({fromSnapshot})) finds a real snapshot to restore.
    makeSnapshot: async () => {
      const v = await storage.createVolume();
      return (await storage.createSnapshot(v.id)).id;
    },
  };
});

describe("FakeComputeProvider", () => {
  it("runs a task with a managed volume and releases it on stop", async () => {
    const storage = await FakeStorageProvider.create();
    const compute = new FakeComputeProvider(storage);

    const task = await compute.runTask({
      workspaceId: workspaceId("ws-1"),
      baseImage: baseImage("golden/node:20"),
      resources: RESOURCES,
    });
    expect(compute.isRunning(task.id)).toBe(true);
    expect((await storage.listVolumes()).map((v) => v.id)).toContain(task.volumeId);

    await compute.stopTask(task.id);
    expect(compute.isRunning(task.id)).toBe(false);
    expect((await storage.listVolumes()).map((v) => v.id)).not.toContain(task.volumeId);
  });
});
