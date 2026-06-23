// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { SYSTEM_TOPOLOGY } from "@edd/core";

import { HealthBadge } from "../components/HealthBadge";
import { useDemo } from "../lib/use-demo";

export function AdminInfra(): JSX.Element {
  const cp = useDemo();
  const cluster = cp.clusterInfo();
  const nodes = cp.topology();
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));

  return (
    <section className="demo-page">
      <h2>Infrastructure</h2>

      <h3 className="demo-subhead">Cluster</h3>
      <div className="stat-grid">
        <div className="stat">
          <div className="num">{cluster.status}</div>
          <div className="lbl">{cluster.name}</div>
        </div>
        <div className="stat">
          <div className="num">{String(cluster.running)}</div>
          <div className="lbl">Running tasks</div>
        </div>
        <div className="stat">
          <div className="num">{String(cluster.pending)}</div>
          <div className="lbl">Pending</div>
        </div>
        <div className="stat">
          <div className="num">{String(nodes.length)}</div>
          <div className="lbl">Topology nodes</div>
        </div>
      </div>

      <h3 className="demo-subhead">Topology</h3>
      <div className="demo-topo">
        {nodes.map((n) => (
          <div key={n.id} className="demo-topo-node">
            <div className="demo-topo-head">
              <span className="demo-topo-label">{n.label}</span>
              <HealthBadge status={n.status} />
            </div>
            <div className="meta">{n.kind}</div>
          </div>
        ))}
      </div>

      <h3 className="demo-subhead">Connections</h3>
      <ul className="adm-rows">
        {SYSTEM_TOPOLOGY.edges.map((e) => (
          <li key={`${e.from}-${e.to}`} className="adm-row">
            <div>
              <code>
                {labelOf.get(e.from) ?? e.from} → {labelOf.get(e.to) ?? e.to}
              </code>
            </div>
            <span className="meta">{e.label}</span>
          </li>
        ))}
      </ul>
      <p className="demo-fine">
        The locked system topology (<code>SYSTEM_TOPOLOGY</code>) with health overlaid by the real{" "}
        <code>overlayTopologyHealth</code>; cluster figures derive from the live fleet.
      </p>
    </section>
  );
}
