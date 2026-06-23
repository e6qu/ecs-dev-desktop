// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";

import { CostBar } from "../components/CostBar";
import { usd } from "../lib/format";
import { useDemo } from "../lib/use-demo";

const WINDOWS: readonly { key: string; label: string; days?: number }[] = [
  { key: "all", label: "All time" },
  { key: "30", label: "30d", days: 30 },
  { key: "7", label: "7d", days: 7 },
  { key: "1", label: "1d", days: 1 },
];

export function AdminCosts(): JSX.Element {
  const cp = useDemo();
  const [win, setWin] = useState<string>("all");
  const days = WINDOWS.find((w) => w.key === win)?.days;
  const report = cp.costReport(days);

  const maxUser = Math.max(0, ...report.byUser.map((u) => u.totalUsd));
  const maxSession = Math.max(0, ...report.bySession.map((s) => s.totalUsd));

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>Costs</h2>
        <div className="demo-tabs">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              className={w.key === win ? "demo-tab active" : "demo-tab"}
              onClick={() => {
                setWin(w.key);
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="num">{usd(report.total.totalUsd)}</div>
          <div className="lbl">Total spend</div>
        </div>
        <div className="stat">
          <div className="num">{usd(report.total.computeUsd)}</div>
          <div className="lbl">Compute</div>
        </div>
        <div className="stat">
          <div className="num">{usd(report.total.volumeUsd)}</div>
          <div className="lbl">Volume</div>
        </div>
        <div className="stat">
          <div className="num">{usd(report.total.snapshotUsd)}</div>
          <div className="lbl">Snapshots</div>
        </div>
      </div>

      <div className="cost-list-head">
        <h3 className="demo-subhead">By user</h3>
        <div className="cost-legend">
          <span className="cost-legend-item">
            <span className="cost-legend-swatch" data-seg="compute" /> compute
          </span>
          <span className="cost-legend-item">
            <span className="cost-legend-swatch" data-seg="volume" /> volume
          </span>
          <span className="cost-legend-item">
            <span className="cost-legend-swatch" data-seg="snapshot" /> snapshot
          </span>
        </div>
      </div>
      <ul className="adm-rows">
        {report.byUser.map((u) => (
          <li key={u.owner} className="adm-row demo-cost-row">
            <div className="demo-cost-id">
              {u.owner}
              <div className="meta">{u.sessions} sessions</div>
            </div>
            <CostBar row={u} maxUsd={maxUser} />
            <div className="demo-cost-usd">{usd(u.totalUsd)}</div>
          </li>
        ))}
      </ul>

      <h3 className="demo-subhead">By session</h3>
      <ul className="adm-rows">
        {report.bySession.map((s) => (
          <li key={s.workspaceId} className="adm-row demo-cost-row">
            <div className="demo-cost-id">
              <code>{s.workspaceId}</code>
              <div className="meta">
                {s.owner} · {s.state}
              </div>
            </div>
            <CostBar row={s} maxUsd={maxSession} />
            <div className="demo-cost-usd">{usd(s.totalUsd)}</div>
          </li>
        ))}
      </ul>

      <p className="demo-fine">
        Prices: {usd(report.pricing.fargateVcpuHourUsd)}/vCPU-hr,{" "}
        {usd(report.pricing.fargateGbHourUsd)}/GB-hr, {usd(report.pricing.ebsGbMonthUsd)}/GB-mo
        volume. Figures are the real cost model run over your seeded audit ledger — stop/start a
        workspace and they move.
      </p>
    </section>
  );
}
