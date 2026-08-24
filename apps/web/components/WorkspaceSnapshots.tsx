// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { WorkspaceSnapshotDto } from "@edd/api-contracts";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { usePoll } from "../lib/usePoll";

const api = new ApiClient({ baseUrl: "" });
/** Snapshots change on lifecycle events, not continuously — a slow poll suffices. */
const SNAPSHOT_POLL_MS = 10_000;

/**
 * The workspace's checkpoint history: every snapshot it owns, newest first,
 * with the current restore point marked and a Restore action per row.
 *
 * Restore is only offered while the workspace is STOPPED — a stop already
 * snapshots the live volume (nothing is lost by stopping first), and the
 * service refuses anything else. What restore gives is the disk half of a
 * CRIU-style resume: files, checkouts and shell state come back exactly as the
 * checkpoint recorded them; processes restart (ECS/Fargate has no
 * memory-checkpoint primitive to build on).
 */
export function WorkspaceSnapshots({ id, state }: { id: string; state: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => (await api.listWorkspaceSnapshots(id)).snapshots, [id]);
  const { data: snapshots } = usePoll<readonly WorkspaceSnapshotDto[]>(
    load,
    SNAPSHOT_POLL_MS,
    "snapshots unavailable",
  );
  const restorable = state === "stopped";

  async function restore(snapshotId: string): Promise<void> {
    setBusy(snapshotId);
    setError(null);
    try {
      await api.restoreWorkspace(id, { snapshotId });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "restore failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-testid="workspace-snapshots">
      <h2>Checkpoints</h2>
      <p className="state-note">
        Point-in-time snapshots of the workspace volume. Stop the workspace, restore a
        checkpoint, and start again to resume from that point — files and checkouts return
        exactly; programs start fresh.
      </p>
      {error !== null && (
        <p role="alert" className="mono" style={{ color: "var(--st-error)", fontSize: 12 }}>
          {error}
        </p>
      )}
      {snapshots === null ? (
        <p className="state-note">loading checkpoints…</p>
      ) : snapshots.length === 0 ? (
        <p className="state-note">no checkpoints yet — take one with Snapshot, or stop the workspace</p>
      ) : (
        <ul className="mono" style={{ listStyle: "none", padding: 0, fontSize: 13 }}>
          {snapshots.map((s) => (
            <li
              key={s.id}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}
            >
              <span style={{ color: "var(--dim)" }}>{new Date(s.createdAt).toLocaleString()}</span>
              <span>{s.id}</span>
              {s.sizeGiB !== undefined && <span style={{ color: "var(--dim)" }}>{s.sizeGiB} GiB</span>}
              {s.current && <span className="pill">restore point</span>}
              {!s.current && (
                <button
                  type="button"
                  className="btn"
                  disabled={!restorable || busy !== null}
                  title={restorable ? "make this the restore point" : "stop the workspace to restore"}
                  onClick={() => void restore(s.id)}
                >
                  {busy === s.id ? "..." : "restore"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
