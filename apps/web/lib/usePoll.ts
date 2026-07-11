// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiError } from "@edd/api-client";
import { useEffect, useState } from "react";

/**
 * Poll an async resource on an interval, exposing the latest value and the last
 * error. Shared by the admin live views (Health board, Infrastructure) so the
 * load/setState/cleanup dance lives in one place. `load` must be stable (defined
 * at module scope or memoised) — it is the effect's only dependency.
 *
 * Polling pauses while the tab is hidden (mirrors `LiveRefresh` — no point
 * hammering the API for a render nobody sees) and refetches immediately when the
 * tab becomes visible again, so the view catches up without waiting a full
 * interval.
 *
 * `errorStatus` carries the HTTP status when the failure was an {@link ApiError}
 * (null otherwise), so callers can distinguish e.g. a genuine 404 ("this resource
 * no longer exists") from a transient failure.
 */
export function usePoll<T>(
  load: () => Promise<T>,
  intervalMs: number,
  fallbackError: string,
): { data: T | null; error: string | null; errorStatus: number | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    // When a `load()` is slower than the interval, requests overlap and can resolve out of
    // order. Apply a result only if it belongs to the latest-STARTED run (monotonic seq),
    // so a slow earlier poll can never overwrite the data/error from a newer one.
    let started = 0;
    let applied = 0;
    async function run(): Promise<void> {
      const seq = ++started;
      try {
        const r = await load();
        if (active && seq > applied) {
          applied = seq;
          setData(r);
          setError(null);
          setErrorStatus(null);
        }
      } catch (e) {
        if (active && seq > applied) {
          applied = seq;
          setError(e instanceof Error ? e.message : fallbackError);
          setErrorStatus(e instanceof ApiError ? e.status : null);
        }
      }
    }
    // Poll only while visible; the same handler on `visibilitychange` refetches
    // the moment the tab is foregrounded again (and no-ops on becoming hidden).
    const tick = (): void => {
      if (document.visibilityState === "visible") void run();
    };
    void run();
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, intervalMs, fallbackError]);

  return { data, error, errorStatus };
}
