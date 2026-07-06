// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";

import { humanAgo, utcStamp } from "../lib/format";

/**
 * The deploy-provenance footer: which build is live (short git sha), how long ago
 * it was built, and the UTC build timestamp. Values are baked into the image at
 * build time (see `@edd/config` `DEPLOY_SHA`/`DEPLOY_TIME`). The "how long ago"
 * part is computed client-side and ticks every 30s; the absolute UTC stamp is the
 * source of truth, so it never goes stale even if the relative label rounds.
 */
export function DeployFooter({ sha, time }: { sha: string; time: string }) {
  const builtMs = time === "" ? Number.NaN : Date.parse(time);
  const hasTime = !Number.isNaN(builtMs);

  // Start null so SSR and first client render agree (no hydration mismatch); fill
  // in the live relative label after mount, then tick it.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const t = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(t);
    };
  }, []);

  const footerStyle = {
    marginTop: 32,
    paddingTop: 12,
    borderTop: "1px solid var(--line, #2a2f27)",
    color: "var(--dim)",
    fontSize: 12,
  } as const;

  if (sha === "" && !hasTime) {
    return (
      <footer
        className="deploy-footer mono"
        data-testid="deploy-footer"
        data-sha="dev"
        style={footerStyle}
      >
        build: local dev
      </footer>
    );
  }

  const ago = hasTime && nowMs !== null ? humanAgo(builtMs, nowMs) : null;
  return (
    <footer
      className="deploy-footer mono"
      data-testid="deploy-footer"
      data-sha={sha === "" ? "unknown" : sha}
      style={footerStyle}
    >
      deployed{" "}
      {sha === "" ? "(unknown commit)" : <code style={{ color: "var(--accent, #9fef00)" }}>{sha}</code>}
      {hasTime && (
        <>
          {" · "}
          {/* suppressHydrationWarning: the relative label is client-only (null on SSR). */}
          <span suppressHydrationWarning>{ago ?? "—"}</span>
          {" · "}
          <time dateTime={new Date(builtMs).toISOString()}>{utcStamp(builtMs)}</time>
        </>
      )}
    </footer>
  );
}
