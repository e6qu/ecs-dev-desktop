// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { TESTID } from "../lib/testids";

const api = new ApiClient({ baseUrl: "" });

/**
 * Permanently delete a terminated (deleted) workspace — the irreversible
 * counterpart of Undelete, before the 7-day auto-purge. Anti-accident UX: the
 * final action is disabled until the user types the exact confirm word, so a
 * mis-click (or muscle-memory Enter) can't destroy the last snapshot of a
 * session's data. The confirm word is the workspace's short id suffix, so it's
 * specific to THIS workspace (can't be blindly pre-typed).
 */
export function PurgeButton({ id }: { id: string }) {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A short, workspace-specific confirm token (the id's first block after `ws-`).
  const confirmWord = id.replace(/^ws-/, "").slice(0, 8);
  const confirmed = typed.trim() === confirmWord;

  async function purge(): Promise<void> {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.purgeWorkspace(id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "permanent delete failed");
      setBusy(false);
    }
  }

  if (!arming) {
    return (
      <button
        type="button"
        className="btn danger"
        data-testid={TESTID.workspacePurge}
        onClick={() => {
          setArming(true);
        }}
      >
        Delete permanently…
      </button>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }} data-testid={TESTID.workspacePurgeConfirm}>
      <p className="state-note" style={{ margin: 0 }}>
        This permanently destroys the workspace and its last snapshot — it cannot be undeleted
        afterwards. Type <code className="mono">{confirmWord}</code> to confirm.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="mono"
          aria-label="type the confirm word to permanently delete"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
          placeholder={confirmWord}
          style={{ padding: "4px 8px", minWidth: 120 }}
        />
        <button
          type="button"
          className="btn danger"
          disabled={!confirmed || busy}
          onClick={() => {
            void purge();
          }}
        >
          {busy ? "deleting…" : "Permanently delete"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setArming(false);
            setTyped("");
            setError(null);
          }}
        >
          cancel
        </button>
      </div>
      {error !== null && (
        <span className="state-note" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
