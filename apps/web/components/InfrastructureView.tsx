// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { InfrastructureReportDto } from "@edd/api-contracts";

import { TESTID } from "../lib/testids";
import { usePoll } from "../lib/usePoll";
import { HealthHead, HealthRows } from "./HealthRows";
import { StateBlock } from "./StateBlock";
import { StatTile } from "./StatTile";

const api = new ApiClient({ baseUrl: "" });
const POLL_MS = 5000;
const load = (): Promise<InfrastructureReportDto> => api.adminInfrastructure();

export function InfrastructureView() {
  const { data: report, error } = usePoll(load, POLL_MS, "infrastructure check failed");

  // Keep the last-known view on a transient poll error (don't blank it); only show a
  // bare error before the first successful load.
  if (report === null) {
    if (error !== null)
      return (
        <div className="notice" role="alert">
          infrastructure check failed: {error}
        </div>
      );
    return (
      <div role="status" aria-busy="true">
        <StateBlock
          title="Loading infrastructure"
          detail="Fetching live cluster, health, and topology data."
        />
      </div>
    );
  }

  const { health, cluster, fleet, topology } = report;
  const clusterStats: { metric: string; value: number }[] = [
    { metric: "running tasks", value: cluster.runningTasks },
    { metric: "pending tasks", value: cluster.pendingTasks },
    { metric: "services", value: cluster.activeServices },
    { metric: "container instances", value: cluster.registeredContainerInstances },
  ];
  const fleetTiles: { metric: string; value: number }[] = [
    { metric: "workspaces", value: fleet.total },
    { metric: "active", value: fleet.active },
    { metric: "running", value: fleet.byState.running },
    { metric: "stopped", value: fleet.byState.stopped },
  ];

  return (
    <>
      {error !== null && (
        <div className="notice" role="status" data-testid="stale-banner">
          last refresh failed ({error}) — showing the last known state
        </div>
      )}
      <HealthHead status={health.status} checkedAt={health.checkedAt} />

      <h2 className="infra-h">Status checks</h2>
      <HealthRows components={health.components} />

      <h2 className="infra-h">
        Compute cluster{" "}
        <span className="badge" data-h={cluster.status === "ACTIVE" ? "ok" : "unknown"}>
          <span className="dot" aria-hidden="true" />
          {cluster.name} · {cluster.status}
        </span>
      </h2>
      <div className="stat-grid">
        {clusterStats.map((s) => (
          <StatTile
            key={s.metric}
            attrs={{
              "data-testid": TESTID.clusterStat,
              "data-metric": s.metric,
              "data-value": s.value,
            }}
            num={s.value}
            label={s.metric}
            sub="ECS"
          />
        ))}
      </div>

      <h2 className="infra-h">Fleet metrics</h2>
      <div className="stat-grid">
        {fleetTiles.map((s) => (
          <StatTile
            key={s.metric}
            attrs={{ "data-stat": s.metric, "data-value": s.value }}
            num={s.value}
            label={s.metric}
            sub="workspaces"
          />
        ))}
      </div>

      <h2 className="infra-h">Components &amp; topology</h2>
      <p className="mono" style={{ color: "var(--dim)", fontSize: 12, marginBottom: 12 }}>
        The platform&apos;s components and how they connect. Live status is overlaid from the health
        board; boundary/dynamic nodes show as unknown (no live check).
      </p>
      <div className="topo-nodes">
        {topology.nodes.map((n) => (
          <div
            key={n.id}
            className="topo-node"
            data-testid={TESTID.topologyNode}
            data-node={n.id}
            data-kind={n.kind}
            data-h={n.status}
          >
            <div className="topo-node-head">
              <span className="badge" data-h={n.status}>
                <span className="dot" aria-hidden="true" />
                {n.status}
              </span>
              <span className="name">{n.label}</span>
              <span className="topo-kind">{n.kind}</span>
            </div>
            <div className="detail">{n.detail ?? n.description}</div>
          </div>
        ))}
      </div>

      <h3 className="infra-h" style={{ fontSize: 14 }}>
        Connections
      </h3>
      <div className="topo-edges">
        {topology.edges.map((e) => (
          <div
            key={`${e.from}->${e.to}:${e.label}`}
            className="topo-edge"
            data-testid={TESTID.topologyEdge}
            data-from={e.from}
            data-to={e.to}
          >
            <span className="mono">{e.from}</span>
            <span className="topo-arrow" aria-hidden="true">
              →
            </span>
            <span className="topo-edge-label">{e.label}</span>
            <span className="topo-arrow" aria-hidden="true">
              →
            </span>
            <span className="mono">{e.to}</span>
          </div>
        ))}
      </div>
    </>
  );
}
