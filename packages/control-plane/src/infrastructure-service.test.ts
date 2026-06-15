// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FakeComputeProvider,
  FakeStorageProvider,
  fixedClock,
  type ComponentHealth,
  type ComputeProvider,
  type ComputeTask,
  type RunTaskInput,
  type TaskId,
  type TaskLiveness,
  type WorkspaceState,
} from "@edd/core";
import { describe, expect, it } from "vitest";

import { HealthService } from "./health-service";
import { InfrastructureService } from "./infrastructure-service";

const NOW = "2026-06-15T00:00:00.000Z";

async function buildService(opts?: {
  database?: ComponentHealth;
  states?: WorkspaceState[];
}): Promise<InfrastructureService> {
  const storage = await FakeStorageProvider.create();
  const compute = new FakeComputeProvider(storage);
  const health = new HealthService({
    storage,
    compute,
    pingDatabase: () =>
      Promise.resolve(opts?.database ?? { component: "dynamodb", status: "ok", detail: "live" }),
    clock: fixedClock(NOW),
  });
  return new InfrastructureService({
    health,
    compute,
    listWorkspaceStates: () => Promise.resolve(opts?.states ?? []),
  });
}

describe("InfrastructureService", () => {
  it("aggregates health, cluster, fleet, and topology in one report", async () => {
    const service = await buildService({
      states: ["running", "running", "idle", "stopped"],
    });
    const report = await service.report();

    // Status checks (health board) are present.
    expect(report.health.components.map((c) => c.component)).toContain("compute");

    // Cluster info comes from the (fake) compute backend — local, no fabricated cloud.
    expect(report.cluster.name).toBe("local");
    expect(report.cluster.status).toBe("local");

    // Fleet metrics tally the supplied states.
    expect(report.fleet.total).toBe(4);
    expect(report.fleet.active).toBe(3); // 2 running + 1 idle
    expect(report.fleet.byState.stopped).toBe(1);

    // Topology is the full system graph with status overlaid.
    expect(report.topology.nodes.length).toBeGreaterThan(0);
    expect(report.topology.edges.length).toBeGreaterThan(0);
  });

  it("lights up topology nodes from live health (degraded DB → degraded node)", async () => {
    const service = await buildService({
      database: { component: "dynamodb", status: "degraded", detail: "table not found" },
    });
    const report = await service.report();
    const dynamo = report.topology.nodes.find((n) => n.id === "dynamodb");
    expect(dynamo?.status).toBe("degraded");
    expect(dynamo?.detail).toBe("table not found");
  });

  it("reports an unknown cluster when the backend exposes no cluster query", async () => {
    const storage = await FakeStorageProvider.create();
    // A minimal backend without the optional clusterInfo capability (real check on AWS).
    const noClusterCompute: ComputeProvider = {
      runTask: (_input: RunTaskInput): Promise<ComputeTask> => Promise.reject(new Error("n/a")),
      stopTask: (_id: TaskId): Promise<void> => Promise.resolve(),
      taskState: (_id: TaskId): Promise<TaskLiveness> => Promise.resolve("stopped"),
    };
    const health = new HealthService({
      storage,
      compute: noClusterCompute,
      pingDatabase: () => Promise.resolve({ component: "dynamodb", status: "ok" }),
      clock: fixedClock(NOW),
    });
    const service = new InfrastructureService({
      health,
      compute: noClusterCompute,
      listWorkspaceStates: () => Promise.resolve([]),
    });
    const report = await service.report();
    expect(report.cluster.status).toBe("unknown");
  });
});
