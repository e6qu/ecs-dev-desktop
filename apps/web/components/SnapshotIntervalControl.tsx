// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { MAX_SNAPSHOT_INTERVAL_MS, MIN_SNAPSHOT_INTERVAL_MS } from "@edd/api-contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const api = new ApiClient({ baseUrl: "" });
const MIN_MINUTES = MIN_SNAPSHOT_INTERVAL_MS / 60000;
const MAX_MINUTES = MAX_SNAPSHOT_INTERVAL_MS / 60000;
/** UI hint when the workspace has no explicit interval (the service default). */
const DEFAULT_INTERVAL_MS = 5 * 60000;

function minutesToMs(value: string): number | null {
  const minutes = Number(value);
  if (!Number.isInteger(minutes)) return null;
  const ms = minutes * 60000;
  return ms >= MIN_SNAPSHOT_INTERVAL_MS && ms <= MAX_SNAPSHOT_INTERVAL_MS ? ms : null;
}

function minutesString(valueMs: number | undefined): string {
  return String(Math.round((valueMs ?? DEFAULT_INTERVAL_MS) / 60000));
}

export function SnapshotIntervalControl({
  id,
  valueMs,
}: {
  id: string;
  valueMs: number | undefined;
}) {
  const router = useRouter();
  const [value, setValue] = useState(minutesString(valueMs));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = minutesToMs(value);
  // True once the admin has typed an unsaved change. While dirty, an incoming
  // prop update must not clobber the draft; while clean, the field resyncs so
  // another admin's change (arriving via the 2s list refresh) becomes visible
  // on an already-mounted card (AGENTS.md rule 13).
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) setValue(minutesString(valueMs));
  }, [valueMs]);

  async function save(): Promise<void> {
    if (parsed === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateWorkspace(id, { snapshotIntervalMs: parsed });
      dirtyRef.current = false;
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "snapshot interval update failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="meta-line" style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <label className="meta-label" htmlFor={`snapshot-interval-${id}`}>
        snapshot interval
      </label>
      <input
        id={`snapshot-interval-${id}`}
        className="input"
        type="number"
        min={MIN_MINUTES}
        max={MAX_MINUTES}
        step={1}
        value={value}
        disabled={busy}
        onChange={(e) => {
          dirtyRef.current = true;
          setValue(e.target.value);
        }}
        style={{ width: 96 }}
      />
      <button
        type="button"
        className="btn"
        disabled={busy || parsed === null}
        onClick={() => void save()}
      >
        {busy ? "..." : "save"}
      </button>
      {error !== null && (
        <span role="alert" className="mono" style={{ color: "var(--st-error)", fontSize: 11 }}>
          {error}
        </span>
      )}
    </div>
  );
}
