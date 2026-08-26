// SPDX-License-Identifier: AGPL-3.0-or-later
import { projectRunRate } from "@edd/core";
import { NextResponse } from "next/server";

import { getCostReport, getInfrastructureService } from "../../../lib/control-plane";
import { checkMonitoringAuth } from "../../../lib/machine-auth";
import { buildObservation } from "../../../lib/observation";
import { withObservability } from "../../../lib/observability";
import { readSelfMemory } from "../../../lib/self-cgroup";

// GET /api/observations — the `e6qu.monitoring/v2` document Shauth collects.
//
// Shauth reads each registered application's monitoring endpoint and renders it
// on the operations page. It could not read this one: the app's catalog entry
// pointed `monitoring_url` at /admin/health, which is a session-authenticated
// health board, not an observation — so nothing was ever collected here.
//
// Authenticated by a shared bearer rather than an operator session, because the
// caller is Shauth itself and has no session to present.

/** The control plane's own Fargate size, as Terraform provisioned it. */
function controlPlaneSizing(): { vcpu: number; memoryGib: number; replicas: number } {
  // Fargate CPU units: 1024 = 1 vCPU. Memory arrives in MiB.
  const cpuUnits = Number(process.env.EDD_CONTROL_PLANE_CPU_UNITS);
  const memoryMb = Number(process.env.EDD_CONTROL_PLANE_MEMORY_MB);
  const replicas = Number(process.env.EDD_CONTROL_PLANE_REPLICAS);
  if (!Number.isFinite(cpuUnits) || !Number.isFinite(memoryMb) || !Number.isFinite(replicas)) {
    // Not defaulted. A guessed control-plane size produces a cost estimate that
    // looks authoritative and is wrong, which is worse than refusing to answer.
    throw new Error(
      "EDD_CONTROL_PLANE_CPU_UNITS, EDD_CONTROL_PLANE_MEMORY_MB and EDD_CONTROL_PLANE_REPLICAS must be set to publish a cost estimate",
    );
  }
  return { vcpu: cpuUnits / 1024, memoryGib: memoryMb / 1024, replicas };
}

async function handleGET(req: Request) {
  const auth = checkMonitoringAuth(req);
  if (auth !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [infrastructure, costs, self] = await Promise.all([
    (await getInfrastructureService()).report(),
    // The full lifecycle report: it carries the pricing actually in force and
    // every non-terminated session's sizing, which is exactly what the run-rate
    // projection wants. It is TTL-cached, so a monitoring poll does not re-scan
    // the ledger on every collection.
    getCostReport(null),
    readSelfMemory(),
  ]);

  // projectRunRate's own contract: pass the CURRENT (non-terminated) sizings. A
  // stopped workspace is included because resuming it would cost this.
  const workspaces = costs.bySession.filter((s) => !s.terminated).map((s) => s.sizing);
  const runRate = projectRunRate(workspaces, controlPlaneSizing(), costs.pricing);

  return NextResponse.json(
    buildObservation({
      observedAt: new Date(),
      health: infrastructure.health,
      cluster: infrastructure.cluster,
      fleet: infrastructure.fleet,
      self,
      runRate,
      unpriced: costs.unpriced,
    }),
  );
}

export const GET = withObservability("observations", handleGET);
