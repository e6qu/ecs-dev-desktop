// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useEffect, useState } from "react";

import { SettingError, useSettingSave } from "../lib/useSettingSave";

const api = new ApiClient({ baseUrl: "" });

/**
 * The idle-stop choices offered. "default" clears the per-workspace override
 * (the deployment default applies); "always-on" exempts the workspace from the
 * idle sweep entirely (manual stop still works, and still snapshots).
 */
const CHOICES = [
  { key: "default", label: "default", ms: null },
  { key: "15m", label: "15 min", ms: 15 * 60000 },
  { key: "1h", label: "1 hour", ms: 60 * 60000 },
  { key: "4h", label: "4 hours", ms: 4 * 60 * 60000 },
  { key: "24h", label: "24 hours", ms: 24 * 60 * 60000 },
  { key: "always-on", label: "always on", ms: null },
] as const;
type ChoiceKey = (typeof CHOICES)[number]["key"];

function choiceFor(idleStopMs: number | undefined, alwaysOn: boolean | undefined): ChoiceKey {
  if (alwaysOn === true) return "always-on";
  if (idleStopMs === undefined) return "default";
  const preset = CHOICES.find((c) => c.ms === idleStopMs);
  return preset?.key ?? "default";
}

export function IdleStopControl({
  id,
  idleStopMs,
  alwaysOn,
}: {
  id: string;
  idleStopMs: number | undefined;
  alwaysOn: boolean | undefined;
}) {
  const [value, setValue] = useState<ChoiceKey>(choiceFor(idleStopMs, alwaysOn));
  const { busy, error, dirtyRef, save } = useSettingSave("idle-stop update failed");

  useEffect(() => {
    if (!dirtyRef.current) setValue(choiceFor(idleStopMs, alwaysOn));
  }, [idleStopMs, alwaysOn, dirtyRef]);

  return (
    <div className="meta-line" style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <label className="meta-label" htmlFor={`idle-stop-${id}`}>
        stop when idle
      </label>
      <select
        id={`idle-stop-${id}`}
        className="input"
        value={value}
        disabled={busy}
        onChange={(e) => {
          dirtyRef.current = true;
          const next = e.target.value as ChoiceKey;
          setValue(next);
          // Every save states BOTH fields: picking a window must also clear a
          // prior always-on, and vice versa — a one-field patch would leave
          // the other override silently in force.
          const choice = CHOICES.find((c) => c.key === next);
          void save(() =>
            api.updateWorkspace(
              id,
              next === "always-on"
                ? { alwaysOn: true, idleStopMs: null }
                : { alwaysOn: false, idleStopMs: choice?.ms ?? null },
            ),
          );
        }}
        style={{ width: 120 }}
      >
        {CHOICES.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <SettingError error={error} />
    </div>
  );
}
