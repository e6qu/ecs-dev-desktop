// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/**
 * The shared busy/error/dirty discipline of the per-workspace settings
 * controls (snapshot interval, idle stop): one in-flight save at a time, the
 * failure message surfaced inline, and `router.refresh()` on BOTH outcomes so
 * the card resyncs to what the server actually holds. `dirtyRef` is the
 * unsaved-draft latch — while set, an incoming prop update must not clobber
 * the draft; a successful save clears it so the periodic list refresh resumes
 * syncing the field (AGENTS.md rule 13).
 */
export function useSettingSave(fallbackError: string): {
  busy: boolean;
  error: string | null;
  dirtyRef: React.RefObject<boolean>;
  save: (action: () => Promise<unknown>) => Promise<void>;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  async function save(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      dirtyRef.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallbackError);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return { busy, error, dirtyRef, save };
}

/** The inline failure line every settings control renders under its input. */
export function SettingError({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <span role="alert" className="mono" style={{ color: "var(--st-error)", fontSize: 11 }}>
      {error}
    </span>
  );
}
