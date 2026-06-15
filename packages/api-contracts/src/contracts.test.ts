// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { createWorkspaceRequest, infrastructureReport, workspace } from "./index";

describe("api-contracts", () => {
  it("accepts a valid workspace", () => {
    const parsed = workspace.parse({
      id: "ws-1",
      ownerId: "user-1",
      baseImage: "golden/node:20",
      state: "running",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    expect(parsed.state).toBe("running");
  });

  it("rejects an empty baseImage on create", () => {
    expect(() => createWorkspaceRequest.parse({ baseImage: "" })).toThrow();
  });

  it("accepts a full infrastructure report (cluster + fleet + topology)", () => {
    const parsed = infrastructureReport.parse({
      health: {
        status: "ok",
        components: [{ component: "compute", status: "ok" }],
        checkedAt: "2026-06-15T00:00:00.000Z",
      },
      cluster: {
        name: "local",
        status: "local",
        runningTasks: 2,
        pendingTasks: 0,
        activeServices: 0,
        registeredContainerInstances: 0,
      },
      fleet: {
        total: 2,
        active: 2,
        byState: { provisioning: 0, running: 2, idle: 0, stopped: 0, terminated: 0, error: 0 },
      },
      topology: {
        nodes: [{ id: "compute", label: "ECS", kind: "compute", description: "x", status: "ok" }],
        edges: [{ from: "compute", to: "storage", label: "EBS" }],
      },
    });
    expect(parsed.cluster.runningTasks).toBe(2);
    expect(parsed.topology.nodes[0]?.id).toBe("compute");
  });
});
