// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { ComponentHealth } from "./health";
import { SYSTEM_TOPOLOGY, overlayTopologyHealth } from "./topology";

describe("system topology", () => {
  it("is a connected graph — every edge endpoint is a declared node", () => {
    const ids = new Set(SYSTEM_TOPOLOGY.nodes.map((n) => n.id));
    for (const e of SYSTEM_TOPOLOGY.edges) {
      expect(ids.has(e.from), `edge.from ${e.from}`).toBe(true);
      expect(ids.has(e.to), `edge.to ${e.to}`).toBe(true);
    }
  });

  it("has unique node ids", () => {
    const ids = SYSTEM_TOPOLOGY.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares the core components an operator expects", () => {
    const ids = new Set(SYSTEM_TOPOLOGY.nodes.map((n) => n.id));
    for (const id of ["control-plane", "dynamodb", "compute", "storage", "reconciler"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe("overlayTopologyHealth", () => {
  const components: ComponentHealth[] = [
    { component: "control-plane", status: "ok", detail: "API responding" },
    { component: "dynamodb", status: "degraded", detail: "table not found" },
    { component: "compute", status: "down", detail: "ECS unreachable" },
  ];

  it("stamps each node with the matching component's status + detail", () => {
    const nodes = overlayTopologyHealth(SYSTEM_TOPOLOGY, components);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("control-plane")?.status).toBe("ok");
    expect(byId.get("dynamodb")?.status).toBe("degraded");
    expect(byId.get("dynamodb")?.detail).toBe("table not found");
    expect(byId.get("compute")?.status).toBe("down");
  });

  it("marks nodes without a live health check as unknown", () => {
    const nodes = overlayTopologyHealth(SYSTEM_TOPOLOGY, components);
    // storage has no component in the report above → unknown, not a fabricated ok.
    expect(nodes.find((n) => n.id === "storage")?.status).toBe("unknown");
  });

  it("preserves the node set and edges (overlay only adds status)", () => {
    const nodes = overlayTopologyHealth(SYSTEM_TOPOLOGY, components);
    expect(nodes.map((n) => n.id).sort()).toEqual(SYSTEM_TOPOLOGY.nodes.map((n) => n.id).sort());
  });
});
