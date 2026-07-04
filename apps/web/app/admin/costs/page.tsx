// SPDX-License-Identifier: AGPL-3.0-or-later
import { COST_WINDOW_DAYS, costReportQuery, type CostWindow } from "@edd/api-contracts";
import Link from "next/link";

import { LiveRefresh } from "../../../components/LiveRefresh";
import { StatTile } from "../../../components/StatTile";
import { getCostService } from "../../../lib/control-plane";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

const MS_PER_HOUR = 60 * 60 * 1000;
/** How often the page re-computes live consumption (running workspaces accrue
 * cost continuously; this keeps the figures current without a manual reload). */
const LIVE_REFRESH_MS = 15_000;

/** The window selector, in display order, with their human labels. */
const WINDOWS: readonly { key: CostWindow; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "30d", label: "30 days" },
  { key: "7d", label: "7 days" },
  { key: "1d", label: "24h" },
];

/** Display USD: cents for visible amounts, more precision for sub-cent figures
 * (sim/short runs) so a real-but-tiny cost never reads as exactly $0.00. */
function usd(value: number): string {
  if (value === 0) return "$0.00";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/** Whole-ish hours, e.g. `12.3h`. */
function hours(ms: number): string {
  return `${(ms / MS_PER_HOUR).toFixed(1)}h`;
}

/** The three priced components of a row, in stack order (largest share first). */
const COST_SEGMENTS: readonly { key: "compute" | "volume" | "snapshot"; label: string }[] = [
  { key: "compute", label: "compute" },
  { key: "volume", label: "volume" },
  { key: "snapshot", label: "snapshot" },
];

/** A row's spend priced into its three components, for the stacked bar. */
interface BarRow {
  readonly totalUsd: number;
  readonly computeUsd: number;
  readonly volumeUsd: number;
  readonly snapshotUsd: number;
}

/** Width of a segment as a percent of the list's max spend, clamped to [0, 100].
 * `maxUsd === 0` (every row $0) yields 0 — never a divide-by-zero. */
function pct(value: number, maxUsd: number): number {
  if (maxUsd <= 0) return 0;
  return Math.min(100, Math.max(0, (value / maxUsd) * 100));
}

/**
 * A horizontal, proportional spend bar for a cost row: its full width is the
 * row's share of the list max (`totalUsd / maxUsd`), stacked from the three
 * priced components (compute / volume / snapshot). Pure presentation — widths are
 * computed server-side, so no client JS. `data-usd`/`data-pct` carry the asserted
 * values; `--seg` colours each component off the lime palette.
 */
function CostBar({ row, maxUsd }: { row: BarRow; maxUsd: number }) {
  const totalPct = pct(row.totalUsd, maxUsd);
  return (
    <div
      className="cost-bar"
      data-testid={TESTID.costBar}
      data-usd={row.totalUsd}
      data-pct={Math.round(totalPct)}
    >
      <div className="cost-bar-track" style={{ width: `${totalPct}%` }}>
        {COST_SEGMENTS.map((s) => {
          const componentUsd = row[`${s.key}Usd`];
          // Width is relative to the track (the row's spend); the track is itself
          // sized to the row's share of the list max, so each segment ends up
          // `componentUsd / maxUsd` of the full bar — the stacked proportion.
          return (
            <div
              key={s.key}
              className="cost-bar-seg"
              data-seg={s.key}
              title={`${s.label} · ${usd(componentUsd)}`}
              style={{ width: `${pct(componentUsd, row.totalUsd)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

// Admin-only (the /admin layout gates it). Fleet spend, derived by pricing the
// lifecycle audit ledger; rolled up per user and per session. `?window=` scopes
// the report to the last N days (default: the full lifetime).
export default async function AdminCostsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  // Validate the window with the SAME schema the `/api/admin/costs` route uses (an
  // absent param defaults to `all`); a bad explicit value falls back to `all` rather
  // than silently coercing via `.catch` (which made the route's validation dead code).
  const parsedWindow = costReportQuery.safeParse({ window: (await searchParams).window });
  const window: CostWindow = parsedWindow.success ? parsedWindow.data.window : "all";
  const report = await (await getCostService()).report(COST_WINDOW_DAYS[window]);
  const { total, byUser, bySession, pricing, sizing } = report;

  // The proportional bars are scaled per list to its most-expensive row, so the
  // top spender fills the bar and the rest read as a fraction of it.
  const maxUserUsd = byUser.reduce((m, u) => Math.max(m, u.totalUsd), 0);
  const maxSessionUsd = bySession.reduce((m, s) => Math.max(m, s.totalUsd), 0);

  const scope =
    window === "all"
      ? "the complete lifecycle"
      : `the last ${WINDOWS.find((w) => w.key === window)?.label ?? window} of the lifecycle`;

  const tiles = [
    { kind: "total", label: "total", value: total.totalUsd, sub: "all components" },
    { kind: "compute", label: "compute", value: total.computeUsd, sub: "Fargate vCPU + memory" },
    { kind: "volume", label: "storage", value: total.volumeUsd, sub: "live EBS volumes" },
    { kind: "snapshot", label: "snapshots", value: total.snapshotUsd, sub: "scaled-to-zero" },
  ];

  return (
    <>
      <LiveRefresh intervalMs={LIVE_REFRESH_MS} />
      <div className="page-head">
        <div>
          <div className="kicker">admin</div>
          <h1>Costs</h1>
          <p>
            Spend computed from {scope} <Link href="/admin/logs">ledger</Link> — every
            workspace&apos;s running vs. scaled-to-zero time, priced at the rates below and updated
            live as workspaces run. Rates: {usd(pricing.fargateVcpuHourUsd)}/vCPU-hr,{" "}
            {usd(pricing.fargateGbHourUsd)}/GB-hr, {usd(pricing.ebsGbMonthUsd)}/GB-mo volume,{" "}
            {usd(pricing.snapshotGbMonthUsd)}/GB-mo snapshot · per workspace: {sizing.vcpu} vCPU,{" "}
            {sizing.memoryGib} GiB, {sizing.volumeGib} GiB disk.
          </p>
        </div>
        <nav className="tabs" aria-label="Cost window">
          {WINDOWS.map((w) => (
            <Link
              key={w.key}
              href={w.key === "all" ? "/admin/costs" : `/admin/costs?window=${w.key}`}
              className={w.key === window ? "on" : ""}
              aria-current={w.key === window ? "page" : undefined}
              data-testid={TESTID.costWindow}
              data-window={w.key}
              data-active={w.key === window}
            >
              {w.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="stat-grid">
        {tiles.map((t) => (
          <StatTile
            key={t.kind}
            attrs={{ "data-testid": TESTID.costTile, "data-cost": t.kind, "data-usd": t.value }}
            num={usd(t.value)}
            label={t.label}
            sub={t.sub}
          />
        ))}
      </div>

      <div className="cost-list-head">
        <h2 style={{ fontSize: 16, margin: "18px 0 10px" }}>By user</h2>
        <div className="cost-legend" aria-label="cost components">
          {COST_SEGMENTS.map((s) => (
            <span key={s.key} className="cost-legend-item">
              <span className="cost-legend-swatch" data-seg={s.key} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      {byUser.length === 0 ? (
        <p className="mono" style={{ color: "var(--dim)" }}>
          no spend recorded yet
        </p>
      ) : (
        <div className="adm-rows">
          {byUser.map((u) => (
            <div
              key={u.owner}
              className="adm-row"
              data-testid={TESTID.costUserRow}
              data-owner={u.owner}
              data-usd={u.totalUsd}
            >
              <span className="wid">{u.owner}</span>
              <span className="detail">{usd(u.totalUsd)}</span>
              <CostBar row={u} maxUsd={maxUserUsd} />
              <div className="meta">
                <span>{u.sessions} session(s)</span>
                <span>compute · {usd(u.computeUsd)}</span>
                <span>storage · {usd(u.volumeUsd + u.snapshotUsd)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, margin: "18px 0 10px" }}>By session</h2>
      {bySession.length === 0 ? (
        <p className="mono" style={{ color: "var(--dim)" }}>
          no sessions yet
        </p>
      ) : (
        <div className="adm-rows">
          {bySession.map((s) => (
            <div
              key={s.workspaceId}
              className="adm-row"
              data-testid={TESTID.costSessionRow}
              data-id={s.workspaceId}
              data-owner={s.owner}
              data-usd={s.totalUsd}
            >
              <span className="wid">{s.workspaceId}</span>
              <span className="detail">{usd(s.totalUsd)}</span>
              <CostBar row={s} maxUsd={maxSessionUsd} />
              <div className="meta">
                <span>owner · {s.owner}</span>
                <span>state · {s.state}</span>
                <span>ran {hours(s.runningMs)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
