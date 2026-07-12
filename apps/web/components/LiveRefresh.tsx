// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Periodically re-renders the current (dynamic) server route, so a page that
 * computes live values — e.g. cost accruing while workspaces run — stays current
 * in near real time without a manual reload. `router.refresh()` re-runs the
 * server component and swaps in the new render, preserving client state.
 *
 * Pauses while the tab is hidden (no point re-running the server render nobody is
 * looking at) and refreshes once on becoming visible again to catch up.
 */
/**
 * Default refresh cadence for admin list/config pages that render server-fetched state which
 * can change out of band (another admin edits, a lifecycle event lands, an invite is accepted).
 * §13 requires every stateful screen to converge without a manual reload; the faster live
 * boards (Health, Overview) set their own tighter intervals. 10s balances freshness vs load.
 */
export const ADMIN_LIST_REFRESH_MS = 10_000;

export function LiveRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const handle = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(handle);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);
  return null;
}
