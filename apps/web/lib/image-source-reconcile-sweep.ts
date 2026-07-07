// SPDX-License-Identifier: AGPL-3.0-or-later
import { IMAGE_SOURCE_RECONCILE_SWEEP_MS } from "@edd/config";
import type { StructuredLogger } from "@edd/core";

import { getImageSourceService, type ImageSourceService } from "./image-source";
import { errorField, log } from "./logger";

interface ImageSourceReconcileDeps {
  readonly service: Pick<ImageSourceService, "reconcileRecentBuilds">;
  readonly logger: Pick<StructuredLogger, "warn">;
}

export interface ImageSourceReconcileRunner {
  readonly run: () => Promise<void>;
}

export function createImageSourceReconcileRunner(
  deps: ImageSourceReconcileDeps,
): ImageSourceReconcileRunner {
  let running = false;
  return {
    async run(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await deps.service.reconcileRecentBuilds();
      } catch (err) {
        deps.logger.warn("image-source reconcile sweep failed (will retry)", {
          error: errorField(err),
        });
      } finally {
        running = false;
      }
    },
  };
}

export function startImageSourceReconcileSweep(): NodeJS.Timeout {
  // Construct the service before installing the timer. Missing required
  // coordinates (repo, branch, webhook secret, app name, variants) fail startup
  // loudly instead of silently disabling catalog rollout.
  const runner = createImageSourceReconcileRunner({
    service: getImageSourceService(),
    logger: log,
  });
  const timer = setInterval(() => {
    void runner.run();
  }, IMAGE_SOURCE_RECONCILE_SWEEP_MS);
  timer.unref();
  void runner.run();
  return timer;
}
