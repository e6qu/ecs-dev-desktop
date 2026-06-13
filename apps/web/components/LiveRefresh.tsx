// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Periodically re-renders the current (dynamic) server route, so a page that
 * computes live values — e.g. cost accruing while workspaces run — stays current
 * in near real time without a manual reload. `router.refresh()` re-runs the
 * server component and swaps in the new render, preserving client state.
 */
export function LiveRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const handle = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [router, intervalMs]);
  return null;
}
