// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import { createImageSourceReconcileRunner } from "./image-source-reconcile-sweep";

describe("createImageSourceReconcileRunner", () => {
  it("reconciles build state", async () => {
    const reconcileRecentBuilds = vi.fn().mockResolvedValue(undefined);
    const runner = createImageSourceReconcileRunner({
      service: { reconcileRecentBuilds },
      logger: { warn: vi.fn() },
    });

    await runner.run();

    expect(reconcileRecentBuilds).toHaveBeenCalledTimes(1);
  });

  it("does not overlap slow sweeps", async () => {
    let release!: () => void;
    const reconcileRecentBuilds = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runner = createImageSourceReconcileRunner({
      service: { reconcileRecentBuilds },
      logger: { warn: vi.fn() },
    });

    const first = runner.run();
    await runner.run();
    release();
    await first;

    expect(reconcileRecentBuilds).toHaveBeenCalledTimes(1);
  });

  it("logs failures and retries on the next sweep", async () => {
    const warn = vi.fn();
    const reconcileRecentBuilds = vi
      .fn()
      .mockRejectedValueOnce(new Error("codebuild unavailable"))
      .mockResolvedValueOnce(undefined);
    const runner = createImageSourceReconcileRunner({
      service: { reconcileRecentBuilds },
      logger: { warn },
    });

    await runner.run();
    await runner.run();

    expect(warn).toHaveBeenCalledWith("image-source reconcile sweep failed (will retry)", {
      error: "codebuild unavailable",
    });
    expect(reconcileRecentBuilds).toHaveBeenCalledTimes(2);
  });
});
