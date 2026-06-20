// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";

/**
 * Poll an async resource on an interval, exposing the latest value and the last
 * error. Shared by the admin live views (Health board, Infrastructure) so the
 * load/setState/cleanup dance lives in one place. `load` must be stable (defined
 * at module scope or memoised) — it is the effect's only dependency.
 */
export function usePoll<T>(
  load: () => Promise<T>,
  intervalMs: number,
  fallbackError: string,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        }
      } catch (e) {
        if (active && seq > applied) {
          applied = seq;
          setError(e instanceof Error ? e.message : fallbackError);
        }
      }
    }
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load, intervalMs, fallbackError]);

  return { data, error };
}
