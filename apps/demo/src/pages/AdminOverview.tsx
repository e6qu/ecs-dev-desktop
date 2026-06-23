// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { StateBadge } from "../components/StateBadge";
import { relTime } from "../lib/format";
import { useDemo } from "../lib/use-demo";

function Tile({ num, label, sub }: { num: string; label: string; sub?: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="num">{num}</div>
      <div className="lbl">{label}</div>
      {sub !== undefined ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function AdminOverview(): JSX.Element {
  const cp = useDemo();
  const stats = cp.fleetStats();
  const owners = new Set(cp.workspaces().map((w) => w.ownerId));
  const recent = cp.audit().slice(0, 6);

  return (
    <section className="demo-page">
      <h2>Fleet overview</h2>
      <div className="stat-grid">
        <Tile num={String(stats.total)} label="Workspaces" sub={`${String(stats.active)} active`} />
        <Tile num={String(stats.active)} label="Active" sub="running or idle" />
        <Tile num={String(owners.size)} label="Active users" />
        <Tile num={String(cp.catalog().length)} label="Base images" />
      </div>

      <h3 className="demo-subhead">By state</h3>
      <div className="stat-grid">
        {Object.entries(stats.byState)
          .filter(([, n]) => n > 0)
          .map(([state, n]) => (
            <Tile key={state} num={String(n)} label={state} />
          ))}
      </div>

      <h3 className="demo-subhead">Recent activity</h3>
      <ul className="adm-rows">
        {recent.map((e, i) => (
          <li key={`${e.target}-${String(i)}`} className="adm-row">
            <div>
              <code>{e.action}</code> · {e.target}
              <div className="meta">
                {e.actor} · {relTime(e.at)}
              </div>
            </div>
            <span className="meta">{e.detail}</span>
          </li>
        ))}
      </ul>
      <p className="demo-fine">
        Every figure here is derived by the real <code>@edd/core</code> functions (
        <code>tallyWorkspaceStates</code>, the audit ledger) over your local seeded state.{" "}
        <StateBadge state="running" /> states come straight from the lifecycle state machine.
      </p>
    </section>
  );
}
