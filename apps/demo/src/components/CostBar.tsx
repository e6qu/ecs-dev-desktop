// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import type { CostBreakdown } from "@edd/core";

import { pct, usd } from "../lib/format";

const SEGMENTS: readonly { key: "compute" | "volume" | "snapshot"; label: string }[] = [
  { key: "compute", label: "Compute" },
  { key: "volume", label: "Volume" },
  { key: "snapshot", label: "Snapshot" },
];

const segUsd = (row: CostBreakdown, key: "compute" | "volume" | "snapshot"): number =>
  key === "compute" ? row.computeUsd : key === "volume" ? row.volumeUsd : row.snapshotUsd;

// Reuses the production .cost-bar/.cost-bar-track/.cost-bar-seg styling from globals.css:
// the track is the row's share of the list max; each segment is the component's share of the
// row total, so the segments stack to the row's proportional width.
export function CostBar({ row, maxUsd }: { row: CostBreakdown; maxUsd: number }): JSX.Element {
  const totalPct = pct(row.totalUsd, maxUsd);
  return (
    <div className="cost-bar" data-usd={row.totalUsd} data-pct={Math.round(totalPct)}>
      <div className="cost-bar-track" style={{ width: `${String(totalPct)}%` }}>
        {SEGMENTS.map((s) => (
          <div
            key={s.key}
            className="cost-bar-seg"
            data-seg={s.key}
            title={`${s.label} · ${usd(segUsd(row, s.key))}`}
            style={{ width: `${String(pct(segUsd(row, s.key), row.totalUsd))}%` }}
          />
        ))}
      </div>
    </div>
  );
}
