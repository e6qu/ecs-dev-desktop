// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import type { AdminSnapshotDto, ListSnapshotsResponse } from "@edd/api-contracts";
import { useCallback, useState } from "react";

import { humanAgo, utcStamp } from "../lib/format";
import { usePoll } from "../lib/usePoll";

/** Stable selectors shared with the Playwright spec (kept local so the shared
 * TESTID registry stays owned by the broader UI work). */
const SNAP_TESTID = {
  row: "admin-snapshot-row",
  purge: "admin-snapshot-purge",
  purgeAll: "admin-snapshot-purge-all",
} as const;

/** Snapshot list refresh cadence — the console converges without a manual reload. */
const SNAPSHOTS_POLL_MS = 5000;

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  throw new Error(`HTTP ${res.status.toString()}`);
}

function shortSnapshot(id: string): string {
  return id.length <= 20 ? id : `${id.slice(0, 20)}…`;
}

function shortWorkspace(id: string): string {
  return id.replace(/^ws-/, "").slice(0, 12);
}

/**
 * Admin snapshot console: lists every managed EBS snapshot with its workspace
 * attribution, size, age, and whether it is retained / still referenced by a
 * workspace. Each unreferenced snapshot gets a two-step-confirm Purge; a bulk
 * "Purge all unreferenced" reaps the accumulated orphans at once. The list polls
 * so out-of-band changes converge without a hard refresh, and a load failure is
 * shown loudly (never a silently empty table — §6.5).
 */
export function SnapshotsConsole() {
  // Bumping the nonce swaps `load`'s identity, so usePoll re-runs immediately after
  // a purge — the table reflects the reap without waiting a poll interval.
  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => {
    void nonce;
    return fetch("/api/admin/snapshots").then((r) => jsonOrThrow<ListSnapshotsResponse>(r));
  }, [nonce]);
  const { data, error } = usePoll(load, SNAPSHOTS_POLL_MS, "snapshots unavailable");

  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const snapshots = data?.snapshots ?? null;
  const unreferenced = (snapshots ?? []).filter((s) => !s.referenced);
  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  async function purge(id: string): Promise<void> {
    setBusy(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/snapshots/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // A referenced snapshot answers 409 — surface the server's clear reason.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status.toString()}`);
      }
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "purge failed");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  async function purgeAll(): Promise<void> {
    setBulkBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/snapshots/purge-unreferenced", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status.toString()}`);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "bulk purge failed");
    } finally {
      setBulkBusy(false);
      setBulkConfirm(false);
    }
  }

  const nowMs = Date.now();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {!bulkConfirm ? (
          <button
            type="button"
            className="btn danger"
            data-testid={SNAP_TESTID.purgeAll}
            disabled={unreferenced.length === 0 || bulkBusy}
            onClick={() => {
              setBulkConfirm(true);
            }}
          >
            Purge all unreferenced
            {unreferenced.length > 0 ? ` (${unreferenced.length.toString()})` : ""}
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="state-note" style={{ margin: 0 }}>
              Permanently delete {unreferenced.length.toString()} unreferenced snapshot
              {unreferenced.length === 1 ? "" : "s"}? This cannot be undone.
            </span>
            <button
              type="button"
              className="btn danger"
              disabled={bulkBusy}
              onClick={() => {
                void purgeAll();
              }}
            >
              {bulkBusy ? "purging…" : "Confirm purge all"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setBulkConfirm(false);
              }}
            >
              cancel
            </button>
          </div>
        )}
      </div>

      {actionError !== null && (
        <span className="state-note" role="alert" style={{ color: "var(--st-error)" }}>
          {actionError}
        </span>
      )}

      <div className="table-scroll" style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>snapshot</th>
              <th>workspace</th>
              <th>size</th>
              <th>created</th>
              <th>state</th>
              <th>action</th>
            </tr>
          </thead>
          <tbody>
            {snapshots?.map((s) => (
              <SnapshotRow
                key={s.id}
                snap={s}
                nowMs={nowMs}
                busy={busy === s.id}
                confirming={confirming === s.id}
                onArm={() => {
                  setConfirming(s.id);
                  setActionError(null);
                }}
                onCancel={() => {
                  setConfirming(null);
                }}
                onConfirm={() => {
                  void purge(s.id);
                }}
              />
            ))}
            {/* A failed load must be visible (§6.5), never a silently empty table. */}
            {error !== null && (
              <tr>
                <td
                  colSpan={6}
                  className="state-note"
                  role="alert"
                  style={{ color: "var(--st-error)" }}
                >
                  {error}
                </td>
              </tr>
            )}
            {error === null && snapshots === null && (
              <tr>
                <td colSpan={6} className="state-note">
                  loading snapshots…
                </td>
              </tr>
            )}
            {error === null && snapshots !== null && snapshots.length === 0 && (
              <tr>
                <td colSpan={6} className="state-note">
                  No snapshots — nothing to clean up.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SnapshotRow({
  snap,
  nowMs,
  busy,
  confirming,
  onArm,
  onCancel,
  onConfirm,
}: {
  snap: AdminSnapshotDto;
  nowMs: number;
  busy: boolean;
  confirming: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const createdMs = Date.parse(snap.createdAt);
  return (
    <tr
      data-testid={SNAP_TESTID.row}
      data-id={snap.id}
      data-referenced={snap.referenced ? "1" : "0"}
      data-retained={snap.retained ? "1" : "0"}
    >
      <td className="mono" style={{ fontSize: 12 }} title={snap.id}>
        {shortSnapshot(snap.id)}
      </td>
      <td className="mono" style={{ fontSize: 12 }}>
        {snap.workspaceId !== undefined ? (
          <span title={snap.workspaceId}>{shortWorkspace(snap.workspaceId)}</span>
        ) : (
          <span style={{ color: "var(--dim)" }}>unattributed</span>
        )}
      </td>
      <td>{snap.sizeGiB !== undefined ? `${snap.sizeGiB.toString()} GiB` : "—"}</td>
      <td className="mono" style={{ fontSize: 12 }} title={utcStamp(createdMs)}>
        {humanAgo(createdMs, nowMs)}
      </td>
      <td>
        <span className="pill-row">
          {snap.retained && <span className="pill on">retained</span>}
          <span className={snap.referenced ? "pill on" : "pill off"}>
            {snap.referenced ? "in use" : "orphan"}
          </span>
        </span>
      </td>
      <td>
        {snap.referenced ? (
          <span
            className="state-note"
            style={{ margin: 0 }}
            title="A workspace still restores from this snapshot; it cannot be purged while in use."
          >
            in use
          </span>
        ) : confirming ? (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>
              {busy ? "purging…" : "confirm"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onCancel}>
              cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn danger"
            data-testid={SNAP_TESTID.purge}
            onClick={onArm}
          >
            Purge…
          </button>
        )}
      </td>
    </tr>
  );
}
