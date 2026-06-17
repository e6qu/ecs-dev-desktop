// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { StatTile } from "../../../components/StatTile";
import { getCatalog } from "../../../lib/control-plane";
import { getFleetStatus } from "../../../lib/fleet-status";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). At-a-glance fleet + catalog state.
export default async function AdminOverviewPage() {
  // The fleet aggregate is cached for a short TTL (see `getFleetStatus`) so this
  // page doesn't re-scan the whole fleet on every load at 200+ workspaces.
  const [{ stats, owners }, catalog] = await Promise.all([getFleetStatus(), getCatalog().list()]);
  const enabled = catalog.filter((c) => c.enabled).length;

  const tiles = [
    { label: "workspaces", value: stats.total, sub: `${stats.active.toString()} active` },
    { label: "stopped", value: stats.byState.stopped, sub: "scaled to zero" },
    { label: "active users", value: owners, sub: "with a workspace" },
    { label: "base images", value: catalog.length, sub: `${enabled.toString()} enabled` },
  ];
  const byState = Object.entries(stats.byState).filter(([, n]) => n > 0);

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
          {byState.map(([state, n]) => (
            <div key={state} className="health-row" data-status={state}>
              <span className="badge" data-status={state}>
                <span className="dot" />
                {state}
              </span>
              <span className="detail">{n}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
