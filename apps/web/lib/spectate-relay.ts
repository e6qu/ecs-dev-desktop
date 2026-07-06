// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-replica spectate relay: the OWNER's editor tab publishes rendered view
 * state (file content, cursor, mouse, terminal output, focus) over one
 * WebSocket; any number of signed-in viewers subscribe and receive the frames.
 * Spectators never hold a connection to the workspace itself — read-only by
 * construction (see docs/design-public-spectate.md).
 *
 * Frames are opaque JSON strings. Snapshot-typed frames (`"t"` values in
 * SNAPSHOT_TYPES) are cached per type so a late-joining spectator immediately
 * receives the current state instead of a blank page.
 *
 * v1 scope: the relay is per-replica. The spectator client retries its
 * WebSocket until it lands on the replica holding the publisher (bounded, with
 * "connecting…" feedback); a replica-to-replica internal relay is the recorded
 * follow-up (DO_NEXT).
 */

/** The minimal socket surface the relay needs (ws.WebSocket satisfies it). */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Frame types cached for snapshot replay to late joiners. Terminal output is
 * deliberately NOT cached — mirroring starts at share-enable/join time, never
 * backfilling scrollback (recorded product decision). */
const SNAPSHOT_TYPES: ReadonlySet<string> = new Set(["file", "cursor", "focus", "tabs", "mouse"]);

/** Close code sent to a subscriber when this replica has no live publisher —
 * the client treats it as "retry another connection", not an error. */
export const NO_PUBLISHER_CODE = 4404;
/** Close code fanned out when the owner stops publishing (tab closed, sharing
 * disabled): spectators show "sharing ended" and stop retrying. */
export const SHARING_ENDED_CODE = 4410;

interface Channel {
  publisher: RelaySocket;
  readonly subscribers: Set<RelaySocket>;
  readonly snapshot: Map<string, string>;
}

export class SpectateRelay {
  private readonly channels = new Map<string, Channel>();

  /** Register the owner's publish socket. A newer publisher (e.g. a reloaded
   * editor tab) replaces the old one — subscribers keep streaming seamlessly.
   * Returns an unpublish function for the socket's close handler. */
  publish(workspaceId: string, socket: RelaySocket): () => void {
    const existing = this.channels.get(workspaceId);
    if (existing !== undefined) {
      existing.publisher.close(1000, "replaced by a newer publisher");
      existing.publisher = socket;
      existing.snapshot.clear();
    } else {
      this.channels.set(workspaceId, {
        publisher: socket,
        subscribers: new Set(),
        snapshot: new Map(),
      });
    }
    return () => {
      const ch = this.channels.get(workspaceId);
      // Only the CURRENT publisher tears the channel down — a replaced socket's
      // late close event must not kill its successor's stream.
      if (ch?.publisher !== socket) return;
      for (const sub of ch.subscribers) {
        try {
          sub.close(SHARING_ENDED_CODE, "sharing ended");
        } catch {
          /* already gone */
        }
      }
      this.channels.delete(workspaceId);
    };
  }

  /** Fan a frame out to every subscriber (and cache snapshot-typed frames). */
  forward(workspaceId: string, frame: string): void {
    const ch = this.channels.get(workspaceId);
    if (ch === undefined) return;
    try {
      const parsed: unknown = JSON.parse(frame);
      const t = (parsed as { t?: unknown }).t;
      if (typeof t === "string" && SNAPSHOT_TYPES.has(t)) ch.snapshot.set(t, frame);
    } catch {
      return; // not JSON — drop rather than relay garbage to viewers
    }
    for (const sub of ch.subscribers) {
      try {
        sub.send(frame);
      } catch {
        ch.subscribers.delete(sub);
      }
    }
  }

  /** Attach a spectator. Immediately replays the cached snapshot; returns an
   * unsubscribe function, or null when this replica has no publisher (the
   * caller closes with NO_PUBLISHER_CODE so the client retries elsewhere). */
  subscribe(workspaceId: string, socket: RelaySocket): (() => void) | null {
    const ch = this.channels.get(workspaceId);
    if (ch === undefined) return null;
    ch.subscribers.add(socket);
    for (const frame of ch.snapshot.values()) socket.send(frame);
    return () => {
      this.channels.get(workspaceId)?.subscribers.delete(socket);
    };
  }

  hasPublisher(workspaceId: string): boolean {
    return this.channels.has(workspaceId);
  }

  subscriberCount(workspaceId: string): number {
    return this.channels.get(workspaceId)?.subscribers.size ?? 0;
  }
}

/** Per-replica singleton (mirrors workspacePresence). */
export const spectateRelay = new SpectateRelay();
