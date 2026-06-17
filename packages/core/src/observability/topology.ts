// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ComponentHealth, HealthStatus } from "./health";

/**
 * The platform's component/network topology — the architecture an operator sees
 * on the admin Infrastructure view. The graph itself (nodes + edges) is a
 * **static fact of the deployment** (the locked architecture in AGENTS.md §1),
 * not runtime-discovered; live status is overlaid onto the nodes from the Health
 * report (see {@link overlayTopologyHealth}) so the topology shows what is up.
 */

/** What a node is, for grouping/iconography on the diagram. */
export type TopologyKind =
  | "client" // an external actor (a user/browser/CLI), not a system we run
  | "edge" // identity-aware proxy / gateway at the network boundary
  | "compute" // a container/task runtime
  | "data" // a persistence store
  | "storage" // block storage / snapshots
  | "worker"; // a background loop

export interface TopologyNode {
  /** Stable id; matches a Health `component` name when the node has a live check. */
  readonly id: string;
  readonly label: string;
  readonly kind: TopologyKind;
  /** One-line description of the node's role. */
  readonly description: string;
}

export interface TopologyEdge {
  readonly from: string;
  readonly to: string;
  /** The relationship/protocol carried over the edge (e.g. "HTTPS", "RunTask"). */
  readonly label: string;
}

export interface Topology {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
}

/** A topology node with its live health overlaid. */
export interface TopologyNodeStatus extends TopologyNode {
  readonly status: HealthStatus;
  readonly detail?: string;
}

/**
 * The locked architecture as a graph. Node ids for the five checkable
 * subsystems (control-plane, dynamodb, compute, storage, reconciler) match the
 * Health board's component names so {@link overlayTopologyHealth} can light them
 * up. Boundary/client nodes have no live check (reported `unknown`).
 */
export const SYSTEM_TOPOLOGY: Topology = {
  nodes: [
    {
      id: "user",
      label: "User",
      kind: "client",
      description: "Developer's browser / SSH client / CLI.",
    },
    {
      id: "proxy",
      label: "Identity-aware proxy",
      kind: "edge",
      description: "Pomerium: authenticates and routes admin/login and wildcard workspace traffic.",
    },
    {
      id: "ssh-gateway",
      label: "SSH gateway",
      kind: "edge",
      description:
        "OpenSSH sshd; authorizes registered keys via ssh-authorize and forwards to the workspace ENI.",
    },
    {
      id: "control-plane",
      label: "Control plane (web)",
      kind: "compute",
      description:
        "Next.js login + admin UI + API; authorizes registered SSH keys and drives the lifecycle.",
    },
    {
      id: "reconciler",
      label: "Reconciler",
      kind: "worker",
      description: "Idle detection → scale-to-zero, snapshots, drift recovery, GC.",
    },
    {
      id: "compute",
      label: "ECS Fargate",
      kind: "compute",
      description: "Runs workspace tasks with managed EBS volumes.",
    },
    {
      id: "workspace",
      label: "Workspace task",
      kind: "compute",
      description: "Per-user VS Code container on Fargate (created on demand).",
    },
    {
      id: "storage",
      label: "EBS storage",
      kind: "storage",
      description: "Snapshots = unit of persistence; hydrate-on-wake, GC.",
    },
    {
      id: "dynamodb",
      label: "DynamoDB",
      kind: "data",
      description: "Single-table state store (workspaces, catalog, audit, cost rollups).",
    },
  ],
  edges: [
    { from: "user", to: "proxy", label: "HTTPS" },
    { from: "user", to: "ssh-gateway", label: "SSH" },
    { from: "proxy", to: "control-plane", label: "admin / login / API" },
    { from: "proxy", to: "workspace", label: "wildcard workspace routing" },
    { from: "control-plane", to: "dynamodb", label: "state (ElectroDB)" },
    { from: "control-plane", to: "compute", label: "RunTask / StopTask" },
    { from: "control-plane", to: "storage", label: "snapshot / restore" },
    { from: "control-plane", to: "ssh-gateway", label: "issues CA certs" },
    { from: "compute", to: "workspace", label: "launches" },
    { from: "compute", to: "storage", label: "managed EBS volume" },
    { from: "ssh-gateway", to: "workspace", label: "forwards to ENI" },
    { from: "reconciler", to: "dynamodb", label: "reads fleet state" },
    { from: "reconciler", to: "compute", label: "scale-to-zero" },
    { from: "reconciler", to: "storage", label: "snapshot / GC" },
  ],
};

/**
 * Pure: overlay a Health report onto a topology. A node whose id matches a
 * reported component takes that component's status + detail; a node with no live
 * check (boundary/client/dynamic nodes) is `unknown` — never a fabricated `ok`.
 */
export function overlayTopologyHealth(
  topology: Topology,
  components: readonly ComponentHealth[],
): TopologyNodeStatus[] {
  const byComponent = new Map(components.map((c) => [c.component, c]));
  return topology.nodes.map((node) => {
    const health = byComponent.get(node.id);
    if (health === undefined) return { ...node, status: "unknown" };
    return health.detail === undefined
      ? { ...node, status: health.status }
      : { ...node, status: health.status, detail: health.detail };
  });
}
