// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

/**
 * One stat tile in an admin stat-grid (Overview, Costs, …). `attrs` carries the
 * `data-testid` + typed `data-*` selectors the Playwright tests assert on, so the
 * tile markup lives in exactly one place.
 */
export function StatTile({
  attrs,
  num,
  label,
  sub,
}: {
  attrs: Record<string, string | number>;
  num: ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <div className="stat" {...attrs}>
      <div className="num">{num}</div>
      <div className="lbl">{label}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
