// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";

/**
 * Top-level error boundary — the safety net under every route so an unhandled
 * server/client error renders a friendly page with a way back, never Next's raw
 * digest screen. Flows with expected failures (invitations, account forms,
 * lifecycle actions) surface their errors inline; only what slips past them
 * lands here.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="panel" role="alert" style={{ maxWidth: 560, margin: "56px auto" }}>
      <h1 style={{ fontSize: 24 }}>Something went wrong</h1>
      <p className="mono" style={{ color: "var(--dim)", marginTop: 10, wordBreak: "break-word" }}>
        {error.message === "" ? "an unexpected error occurred" : error.message}
        {error.digest === undefined ? "" : ` (ref ${error.digest})`}
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            reset();
          }}
        >
          try again
        </button>
        <Link className="btn primary" href="/workspaces">
          back to workspaces
        </Link>
      </div>
    </div>
  );
}
