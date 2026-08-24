// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { MAX_SNAPSHOT_INTERVAL_MS, MIN_SNAPSHOT_INTERVAL_MS } from "@edd/api-contracts";
import { useEffect, useState } from "react";

import { SettingError, useSettingSave } from "../lib/useSettingSave";

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
  const [value, setValue] = useState(minutesString(valueMs));
  const { busy, error, dirtyRef, save } = useSettingSave("snapshot interval update failed");
  const parsed = minutesToMs(value);

  useEffect(() => {
    if (!dirtyRef.current) setValue(minutesString(valueMs));
  }, [valueMs, dirtyRef]);

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
        onClick={() => {
          if (parsed === null) return;
          void save(() => api.updateWorkspace(id, { snapshotIntervalMs: parsed }));
        }}
      >
        {busy ? "..." : "save"}
      </button>
      <SettingError error={error} />
    </div>
  );
}
