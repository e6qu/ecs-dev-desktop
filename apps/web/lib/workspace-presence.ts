// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId, type WorkspaceId } from "@edd/core";

import { getControlPlane } from "./control-plane";
import { errorField, log } from "./logger";

/**
 * Connection-based workspace presence: "in use" means a user has the workspace
 * LOADED — an editor tab (even a background tab with zero interaction) holds at
 * least one live WebSocket through the `/w/<id>/` proxy. Each control-plane
 * replica tracks the connections IT proxies and periodically refreshes
 * `lastActivity` for the workspaces they belong to, so an open tab keeps the
 * workspace running — but only until the authorizing session's expiry captured
 * at upgrade time. A backgrounded tab never rolls its session (no new requests
 * carry a fresh cookie through the socket), so a tab-parked workspace lives at
 * most one session length (4 h), then ages into the reconciler's idle cooldown
 * and is snapshotted + stopped.
 *
 * The in-container idle-agent's interaction signals (PTY, editor events, CPU,
 * SSH connections) are complementary: they cover usage that never holds a proxy
 * socket (SSH-only sessions, detached background compute).
 */

interface TrackedConnection {
  readonly wsId: WorkspaceId;
  /** The authorizing session's expiry — the connection stops counting as
   * presence past this instant even if the socket stays open. */
  readonly sessionExpiresAtMs: number;
}

export class PresenceRegistry {
  private nextId = 1;
  private readonly conns = new Map<number, TrackedConnection>();

  /** Record a live proxied connection; returns the untrack function (call on
   * socket close). */
  track(wsId: WorkspaceId, sessionExpiresAtMs: number): () => void {
    const id = this.nextId++;
    this.conns.set(id, { wsId, sessionExpiresAtMs });
    return () => {
      this.conns.delete(id);
    };
  }

  /** Distinct workspaces with at least one live connection whose session is
   * still valid at `nowMs`. Session-expired entries are pruned as a side effect
   * (their sockets may linger, but they no longer count as presence). */
  loadedWorkspaces(nowMs: number): WorkspaceId[] {
    const loaded = new Set<WorkspaceId>();
    for (const [id, conn] of this.conns) {
      if (conn.sessionExpiresAtMs <= nowMs) this.conns.delete(id);
      else loaded.add(conn.wsId);
    }
    return [...loaded];
  }

  /** Live tracked connections (post-prune count is what matters; for tests/metrics). */
  size(): number {
    return this.conns.size;
  }
}

/** Per-replica singleton: each control-plane task sweeps its own connections. */
export const workspacePresence = new PresenceRegistry();

/** How often each replica refreshes `lastActivity` for its loaded workspaces.
 * Must be comfortably inside the idle cooldown (5 min) so presence never ages out
 * between sweeps. */
export const PRESENCE_SWEEP_MS = 60_000;

/**
 * One presence sweep: an `active` heartbeat for every workspace this replica has
 * loaded. A typed heartbeat failure (e.g. the workspace was stopped/deleted from
 * under a lingering socket) is expected and ignored; an unexpected throw is
 * logged, never fatal — presence must not take the server down.
 */
export async function sweepPresence(
  registry: PresenceRegistry = workspacePresence,
  nowMs: number = Date.now(),
): Promise<void> {
  const loaded = registry.loadedWorkspaces(nowMs);
  if (loaded.length === 0) return;
  const cp = await getControlPlane();
  for (const id of loaded) {
    try {
      await cp.heartbeat(workspaceId(id), { active: true });
    } catch (err) {
      log.warn("presence heartbeat failed", { workspaceId: id, error: errorField(err) });
    }
  }
}
