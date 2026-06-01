// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { FakeComputeProvider } from "./fake-compute-provider";

describe("FakeComputeProvider", () => {
  it("runs and stops a task", async () => {
    const compute = new FakeComputeProvider();
    const task = await compute.runTask({
      workspaceId: "ws-1",
      baseImage: "golden/node:20",
      volumeId: "vol-1",
    });
    expect(compute.isRunning(task.id)).toBe(true);
    await compute.stopTask(task.id);
    expect(compute.isRunning(task.id)).toBe(false);
  });
});
