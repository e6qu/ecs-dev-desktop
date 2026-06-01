// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_IDLE_THRESHOLD_MS,
  isoTimestamp,
  type Clock,
  type IsoTimestamp,
  type WorkspaceId,
} from "@edd/core";

/** An active workspace the reconciler may scale to zero. */
export interface ActiveWorkspace {
  id: WorkspaceId;
  lastActivity: IsoTimestamp;
}

/**
 * The control-plane operations the reconciler drives. A port (not the concrete
 * `WorkspaceService`) so the reconciler is decoupled and unit-testable with a
 * fake; `WorkspaceService` satisfies it structurally.
 */
export interface ReconcilerService {
  listActive(): Promise<readonly ActiveWorkspace[]>;
  stop(id: WorkspaceId): Promise<unknown>;
}

/** Pure: the ids of workspaces idle for at least `idleThresholdMs`. */
export function selectIdle(
  active: readonly ActiveWorkspace[],
  now: IsoTimestamp,
  idleThresholdMs: number,
): WorkspaceId[] {
  const nowMs = Date.parse(now);
  return active
    .filter((w) => nowMs - Date.parse(w.lastActivity) >= idleThresholdMs)
    .map((w) => w.id);
}

export interface ReconcilerDeps {
  service: ReconcilerService;
  clock: Clock;
  /** Idle window before scale-to-zero; defaults to `DEFAULT_IDLE_THRESHOLD_MS`. */
  idleThresholdMs?: number;
}

export interface ReconcileResult {
  scanned: number;
  stopped: number;
}

/**
 * Imperative shell: gather active workspaces, decide which are idle (pure), then
 * scale those to zero through the control plane (snapshot + tear down).
 */
export class Reconciler {
  private readonly idleThresholdMs: number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  }

  async runOnce(): Promise<ReconcileResult> {
    const active = await this.deps.service.listActive();
    const now = isoTimestamp(this.deps.clock.now());
    const toStop = selectIdle(active, now, this.idleThresholdMs);
    for (const id of toStop) {
      await this.deps.service.stop(id);
    }
    return { scanned: active.length, stopped: toStop.length };
  }
}
