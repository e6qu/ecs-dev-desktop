// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock, ComputeProvider, StorageProvider } from "@edd/core";
import {
  FakeComputeProvider,
  FakeStorageProvider,
  fixedClock,
  type ComponentHealth,
} from "@edd/core";
import { describe, expect, it } from "vitest";

import { HealthService, type HealthServiceDeps } from "./health-service";

const NOW = "2026-06-04T00:30:00.000Z";
const pingOk = (): Promise<ComponentHealth> =>
  Promise.resolve({ component: "dynamodb", status: "ok" });

async function baseDeps(): Promise<Omit<HealthServiceDeps, "reconcilerHeartbeat">> {
  const storage = await FakeStorageProvider.create();
  return {
    storage,
    compute: new FakeComputeProvider(storage),
    pingDatabase: pingOk,
    clock: fixedClock(NOW),
  };
}

function reconciler(report: Awaited<ReturnType<HealthService["report"]>>): ComponentHealth {
  const found = report.components.find((c) => c.component === "reconciler");
  if (found === undefined) throw new Error("reconciler component missing from health report");
  return found;
}

describe("HealthService — reconciler health", () => {
  it("is unknown when no heartbeat reader is wired", async () => {
    const report = await new HealthService(await baseDeps()).report();
    expect(reconciler(report).status).toBe("unknown");
  });

  it("is ok when the last sweep is recent", async () => {
    const deps: HealthServiceDeps = {
      ...(await baseDeps()),
      reconcilerHeartbeat: () => Promise.resolve({ lastRunAt: "2026-06-04T00:25:00.000Z" }),
    };
    expect(reconciler(await new HealthService(deps).report()).status).toBe("ok");
  });

  it("is degraded when the last sweep is stale", async () => {
    const deps: HealthServiceDeps = {
      ...(await baseDeps()),
      reconcilerHeartbeat: () => Promise.resolve({ lastRunAt: "2026-06-04T00:00:00.000Z" }),
    };
    expect(reconciler(await new HealthService(deps).report()).status).toBe("degraded");
  });
});

describe("HealthService.report concurrency", () => {
  it("starts every dependency check before any of them has answered", () => {
    const calls: string[] = [];
    // Promise.race of nothing never settles: a check that never answers.
    const neverAnswering = (name: string) => (): Promise<never> => {
      calls.push(name);
      return Promise.race([]);
    };
    const service = new HealthService({
      pingDatabase: neverAnswering("database"),
      compute: { health: neverAnswering("compute") } as unknown as ComputeProvider,
      storage: { health: neverAnswering("storage") } as unknown as StorageProvider,
      reconcilerHeartbeat: neverAnswering("reconciler"),
      gitIntegration: neverAnswering("git"),
      clock: { now: () => new Date(0) } as unknown as Clock,
    });

    // None of the checks ever answers, so a report that awaited them one by one
    // would have started only the first by the time it returns its promise.
    void service.report();

    expect(calls.sort()).toEqual(["compute", "database", "git", "reconciler", "storage"]);
  });
});
