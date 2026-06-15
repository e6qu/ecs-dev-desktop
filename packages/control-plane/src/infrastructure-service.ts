// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  SYSTEM_TOPOLOGY,
  overlayTopologyHealth,
  tallyWorkspaceStates,
  type ClusterInfo,
  type ComputeProvider,
  type HealthReport,
  type TopologyEdge,
  type TopologyNodeStatus,
  type WorkspaceState,
  type WorkspaceStats,
} from "@edd/core";

import type { HealthService } from "./health-service";

/** The topology with live status overlaid on its nodes. */
export interface TopologyView {
  readonly nodes: readonly TopologyNodeStatus[];
  readonly edges: readonly TopologyEdge[];
}

/**
 * Everything the admin Infrastructure view needs in one shot: dependency status
 * checks, the compute cluster's live state, fleet metrics, and the component
 * topology lit up with health. A single aggregate keeps the page to one round
 * trip and the route thin.
 */
export interface InfrastructureReport {
  readonly health: HealthReport;
  readonly cluster: ClusterInfo;
  readonly fleet: WorkspaceStats;
  readonly topology: TopologyView;
}

export interface InfrastructureServiceDeps {
  /** Provides the dependency Health report (also the source for topology status). */
  health: HealthService;
  /** Compute backend — queried for live cluster state. */
  compute: ComputeProvider;
  /** Current workspace lifecycle states (for fleet metrics). */
  listWorkspaceStates: () => Promise<readonly WorkspaceState[]>;
}

/** A cluster row for a backend that exposes no live cluster query (real check on
 * AWS) — `unknown`, never fabricated counts. */
const UNKNOWN_CLUSTER: ClusterInfo = {
  name: "unknown",
  status: "unknown",
  runningTasks: 0,
  pendingTasks: 0,
  activeServices: 0,
  registeredContainerInstances: 0,
};

/**
 * Imperative shell that assembles the admin Infrastructure view from the health
 * board, the compute cluster, fleet state, and the (static) system topology. The
 * topology graph + overlay are pure (`@edd/core`); this only does the I/O.
 */
export class InfrastructureService {
  constructor(private readonly deps: InfrastructureServiceDeps) {}

  async report(): Promise<InfrastructureReport> {
    const [health, cluster, states] = await Promise.all([
      this.deps.health.report(),
      this.deps.compute.clusterInfo === undefined
        ? Promise.resolve(UNKNOWN_CLUSTER)
        : this.deps.compute.clusterInfo(),
      this.deps.listWorkspaceStates(),
    ]);
    return {
      health,
      cluster,
      fleet: tallyWorkspaceStates(states),
      topology: {
        nodes: overlayTopologyHealth(SYSTEM_TOPOLOGY, health.components),
        edges: SYSTEM_TOPOLOGY.edges,
      },
    };
  }
}
