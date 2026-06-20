// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { StatTile } from "../../../components/StatTile";
import { getOverviewReport } from "../../../lib/overview-report";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). Renders the overview report (fleet + catalog
// counts) from the shared builder — the same data `GET /api/admin/overview` serves.
export default async function AdminOverviewPage() {
  const { workspaces, activeUsers, baseImages, byState } = await getOverviewReport();

  const tiles = [
    { label: "workspaces", value: workspaces.total, sub: `${workspaces.active.toString()} active` },
    { label: "stopped", value: workspaces.stopped, sub: "scaled to zero" },
    { label: "active users", value: activeUsers, sub: "with a workspace" },
    {
      label: "base images",
      value: baseImages.total,
      sub: `${baseImages.enabled.toString()} enabled`,
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">admin</div>
          <h1>Overview</h1>
          <p>
            Fleet and catalog at a glance. See <Link href="/admin/health">Health</Link> for
            dependency status and <Link href="/admin/workspaces">Workspaces</Link> to inspect one.
          </p>
        </div>
      </div>

      <div className="stat-grid">
        {tiles.map((t) => (
          <StatTile
            key={t.label}
            attrs={{ "data-testid": TESTID.statTile, "data-stat": t.label, "data-value": t.value }}
            num={t.value}
            label={t.label}
            sub={t.sub}
          />
        ))}
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 10 }}>By state</h2>
      {byState.length === 0 ? (
        <p className="state-note">no workspaces yet</p>
      ) : (
        <div className="health-rows">
          {byState.map(({ state, count }) => (
            <div key={state} className="health-row" data-status={state}>
              <span className="badge" data-status={state}>
                <span className="dot" />
                {state}
              </span>
              <span className="detail">{count}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
