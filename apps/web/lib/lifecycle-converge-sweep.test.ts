// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import { describe, expect, it, vi } from "vitest";

import { createLifecycleConvergeRunner } from "./lifecycle-converge-sweep";

const stopping = workspaceId("ws-stopping");
const deleting = workspaceId("ws-deleting");

function controlPlane(
  overrides: Partial<
    Record<"finishStop" | "finishDeleting", (id: unknown) => Promise<unknown>>
  > = {},
) {
  return {
    listStopping: vi.fn().mockResolvedValue([{ id: stopping }]),
    finishStop: vi.fn(overrides.finishStop ?? (() => Promise.resolve({ ok: true }))),
    listDeleting: vi.fn().mockResolvedValue([{ id: deleting }]),
    finishDeleting: vi.fn(overrides.finishDeleting ?? (() => Promise.resolve({ ok: true }))),
  };
}

describe("createLifecycleConvergeRunner", () => {
  it("converges both tombstones on one tick, deleting included", async () => {
    // The regression: `deleting` was left to the reconciler's five-minute
    // tick, so a delete's StopTask went out minutes after the 202.
    const cp = controlPlane();
    const runner = createLifecycleConvergeRunner({
      cp: () => Promise.resolve(cp),
      logger: { warn: vi.fn() },
    });

    await runner.run();

    expect(cp.finishStop).toHaveBeenCalledWith(stopping);
    expect(cp.finishDeleting).toHaveBeenCalledWith(deleting);
  });

  it("does not start a second finishDeleting for a workspace still being converged", async () => {
    let release!: () => void;
    const cp = controlPlane({
      finishDeleting: () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ ok: true });
          };
        }),
    });
    const runner = createLifecycleConvergeRunner({
      cp: () => Promise.resolve(cp),
      logger: { warn: vi.fn() },
    });

    const first = runner.run();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.run();
    release();
    await first;

    expect(cp.finishDeleting).toHaveBeenCalledTimes(1);
    expect(cp.finishStop).toHaveBeenCalledTimes(2);
  });

  it("isolates one workspace's failure and keeps converging the rest", async () => {
    const warn = vi.fn();
    const cp = controlPlane({ finishStop: () => Promise.reject(new Error("snapshot failed")) });
    const runner = createLifecycleConvergeRunner({
      cp: () => Promise.resolve(cp),
      logger: { warn },
    });

    await runner.run();

    expect(cp.finishDeleting).toHaveBeenCalledWith(deleting);
    expect(warn).toHaveBeenCalledWith(
      "stopping converge failed for one workspace (will retry)",
      expect.objectContaining({ workspaceId: stopping }),
    );
  });
});
