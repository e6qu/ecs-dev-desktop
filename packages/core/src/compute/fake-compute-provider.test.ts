// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { baseImage, workspaceId } from "../domain/ids";
import { FakeStorageProvider } from "../storage/fake-storage-provider";
import { FakeComputeProvider } from "./fake-compute-provider";

describe("FakeComputeProvider", () => {
  it("runs a task with a managed volume and releases it on stop", async () => {
    const storage = await FakeStorageProvider.create();
    const compute = new FakeComputeProvider(storage);

    const task = await compute.runTask({
      workspaceId: workspaceId("ws-1"),
      baseImage: baseImage("golden/node:20"),
    });
    expect(compute.isRunning(task.id)).toBe(true);
    expect((await storage.listVolumes()).map((v) => v.id)).toContain(task.volumeId);

    await compute.stopTask(task.id);
    expect(compute.isRunning(task.id)).toBe(false);
    expect((await storage.listVolumes()).map((v) => v.id)).not.toContain(task.volumeId);
  });
});
