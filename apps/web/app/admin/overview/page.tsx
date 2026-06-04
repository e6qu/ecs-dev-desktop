// SPDX-License-Identifier: AGPL-3.0-or-later
import { tallyWorkspaceStates } from "@edd/core";
import Link from "next/link";

import { getCatalog, getControlPlane } from "../../../lib/control-plane";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). At-a-glance fleet + catalog state.
export default async function AdminOverviewPage() {
  const cp = await getControlPlane();
  const [workspaces, catalog] = await Promise.all([cp.list(), getCatalog().list()]);
  const stats = tallyWorkspaceStates(workspaces.map((w) => w.state));
  const owners = new Set(workspaces.map((w) => w.ownerId)).size;
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
          <div key={t.label} className="stat">
            <div className="num">{t.value}</div>
            <div className="lbl">{t.label}</div>
            <div className="sub">{t.sub}</div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 10 }}>By state</h2>
      {byState.length === 0 ? (
        <p className="mono" style={{ color: "var(--dim)" }}>
          no workspaces yet
        </p>
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
