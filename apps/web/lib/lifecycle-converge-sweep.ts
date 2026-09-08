// SPDX-License-Identifier: AGPL-3.0-or-later
import { STOPPING_SWEEP_MS } from "@edd/config";
import type { StructuredLogger, WorkspaceId } from "@edd/core";

import { getControlPlane } from "./control-plane";
import { errorField, log } from "./logger";

/**
 * The two tombstone states a user action leaves behind and the reconciler
 * converges: `stopping` (finishStop, grace-honoring) and `deleting`
 * (finishDeleting: final snapshot, stop the task, remove the record). Both are
 * idempotent and version-conditioned, so this sweep in the long-lived server
 * process converges them within one tick, and the reconciler's own passes stay
 * the cross-replica / server-restart backstop.
 *
 * `deleting` joined this sweep after a measurement on the shared dev
 * environment: the delete route answered 202 at 10:35:50 and the ECS StopTask
 * went out at 10:39:42, on the reconciler's next five-minute tick. A user's
 * delete was taking up to five minutes, and the environment's browser gate
 * spent four of its five workspace minutes waiting for it.
 */
interface LifecycleConvergeDeps {
  readonly cp: () => Promise<{
    listStopping(): Promise<readonly { readonly id: WorkspaceId }[]>;
    finishStop(id: WorkspaceId): Promise<unknown>;
    listDeleting(): Promise<readonly { readonly id: WorkspaceId }[]>;
    finishDeleting(id: WorkspaceId): Promise<unknown>;
  }>;
  readonly logger: Pick<StructuredLogger, "warn">;
}

export interface LifecycleConvergeRunner {
  readonly run: () => Promise<void>;
}

export function createLifecycleConvergeRunner(
  deps: LifecycleConvergeDeps,
): LifecycleConvergeRunner {
  // A finishDeleting can outlast the tick (it snapshots a live volume first);
  // a workspace already being converged is left to that call, so two calls
  // never race the same snapshot.
  const inFlight = new Set<WorkspaceId>();
  const converge = async (
    id: WorkspaceId,
    finish: (id: WorkspaceId) => Promise<unknown>,
    what: string,
  ): Promise<void> => {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      await finish(id);
    } catch (err) {
      deps.logger.warn(`${what} converge failed for one workspace (will retry)`, {
        workspaceId: id,
        error: errorField(err),
      });
    } finally {
      inFlight.delete(id);
    }
  };
  return {
    async run(): Promise<void> {
      let cp: Awaited<ReturnType<LifecycleConvergeDeps["cp"]>>;
      try {
        cp = await deps.cp();
      } catch (err) {
        deps.logger.warn(
          "lifecycle converge sweep could not reach the control plane (will retry)",
          {
            error: errorField(err),
          },
        );
        return;
      }
      try {
        for (const ws of await cp.listStopping())
          await converge(ws.id, (id) => cp.finishStop(id), "stopping");
        for (const ws of await cp.listDeleting())
          await converge(ws.id, (id) => cp.finishDeleting(id), "deleting");
      } catch (err) {
        deps.logger.warn("lifecycle converge sweep failed (will retry)", {
          error: errorField(err),
        });
      }
    },
  };
}

export function startLifecycleConvergeSweep(): NodeJS.Timeout {
  const runner = createLifecycleConvergeRunner({ cp: getControlPlane, logger: log });
  const timer = setInterval(() => {
    void runner.run();
  }, STOPPING_SWEEP_MS);
  timer.unref();
  return timer;
}
