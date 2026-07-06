// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { TESTID } from "../lib/testids";

const api = new ApiClient({ baseUrl: "" });

/**
 * The spectate toggle on a workspace card (owner only, default off). Enabling
 * goes through an explicit confirmation spelling out exactly what becomes
 * visible and to whom (recorded design requirement); while enabled, the card
 * shows the spectate URL with copy + stop-sharing controls.
 */
export function ShareToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const spectatePath = `/workspaces/${id}/spectate`;

  async function setShare(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.setWorkspaceShare(id, next);
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "share toggle failed");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled && !confirming) {
    return (
      <div className="meta-line">
        <button
          type="button"
          className="btn"
          data-testid={TESTID.workspaceShareToggle}
          data-enabled="false"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Share view…
        </button>
        {error !== null && <span className="state-note">{error}</span>}
      </div>
    );
  }

  if (!enabled && confirming) {
    return (
      <div className="meta-line" style={{ display: "block" }}>
        <p className="state-note" style={{ margin: "4px 0" }}>
          Every signed-in EDD user (viewer role or above) will see a live, read-only mirror of this
          session: open files, your cursor and mouse, terminal output, and everything you type —
          including any secrets that appear on screen. Mirroring starts now (no earlier scrollback).
          You can stop sharing at any time.
        </p>
        <button
          type="button"
          className="btn danger"
          data-testid={TESTID.workspaceShareToggle}
          data-enabled="false"
          disabled={busy}
          onClick={() => {
            void setShare(true);
          }}
        >
          {busy ? "enabling…" : "I understand — share"}
        </button>{" "}
        <button
          type="button"
          className="btn"
          onClick={() => {
            setConfirming(false);
          }}
        >
          cancel
        </button>
        {error !== null && <span className="state-note">{error}</span>}
      </div>
    );
  }

  return (
    <div className="meta-line" style={{ display: "block" }}>
      <span className="state-note">shared — viewers can watch this session</span>{" "}
      <a className="btn" href={spectatePath}>
        open spectate view
      </a>{" "}
      <button
        type="button"
        className="btn"
        onClick={() => {
          void navigator.clipboard.writeText(new URL(spectatePath, window.location.origin).href);
          setCopied(true);
          window.setTimeout(() => {
            setCopied(false);
          }, 1500);
        }}
      >
        {copied ? "copied" : "copy link"}
      </button>{" "}
      <button
        type="button"
        className="btn danger"
        data-testid={TESTID.workspaceShareToggle}
        data-enabled="true"
        disabled={busy}
        onClick={() => {
          void setShare(false);
        }}
      >
        {busy ? "stopping…" : "stop sharing"}
      </button>
      {error !== null && <span className="state-note">{error}</span>}
    </div>
  );
}
