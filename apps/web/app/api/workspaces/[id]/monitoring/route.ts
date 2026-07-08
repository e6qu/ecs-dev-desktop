// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import type { MonitoringSeriesDto, WorkspaceMonitoringDto } from "@edd/api-contracts";
import { baseImage } from "@edd/core";
import { taskDefinitionFamily } from "@edd/compute-ecs";
import type { CloudWatchMetricReader } from "@edd/cloudwatch-metrics";

import { isResponse, loadOwnedWorkspaceDetail } from "../../../../../lib/api";
import { getCostService, getMetricReader } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Utilization/IOPS lookback window and datapoint period. */
const SERIES_WINDOW_MS = 3 * 60 * 60 * 1000;
const SERIES_PERIOD_S = 300;

/** gp3 baseline IOPS — what the managed EBS home volume is provisioned with (the
 * compute provider requests plain gp3, which always includes this baseline). */
const GP3_BASELINE_IOPS = 3000;

const NO_METRICS: MonitoringSeriesDto = {
  available: false,
  note: "utilization metrics stream from CloudWatch on AWS",
  points: [],
};

async function readSeries(
  reader: CloudWatchMetricReader | null,
  query: {
    namespace: string;
    metricName: string;
    dimensions: Record<string, string>;
    stat: "Average" | "Sum";
  },
  window: { startMs: number; endMs: number },
): Promise<MonitoringSeriesDto> {
  if (reader === null) return NO_METRICS;
  const result = await reader.readSeries({ ...query, periodS: SERIES_PERIOD_S }, window);
  return { available: result.available, note: result.note, points: [...result.points] };
}

// GET /api/workspaces/:id/monitoring — the owner-facing monitoring bundle:
// provisioned sizing, uptime, cost so far (incl. the snapshot-storage line),
// task utilization (Container Insights), and per-volume EBS IOPS.
async function handleGET(req: Request, { params }: Ctx) {
  const loaded = await loadOwnedWorkspaceDetail(req, params);
  if (isResponse(loaded)) return loaded;
  const { ctx, detail } = loaded;
  const ws = detail.workspace;
  const sizing = {
    vcpu: ws.resources.cpuUnits / 1024,
    memoryGib: ws.resources.memoryMiB / 1024,
    volumeGib: ws.resources.volumeGiB,
  };

  // Cost + uptime from the audit-priced report (the same source /admin/costs uses),
  // narrowed to this session. Absent until the ledger has priced events.
  const report = await (await getCostService()).report(null);
  const session = report.bySession.find((s) => s.workspaceId === ctx.id);

  const reader = getMetricReader();
  const now = Date.now();
  const window = { startMs: now - SERIES_WINDOW_MS, endMs: now };
  const cluster = process.env.ECS_CLUSTER ?? "";
  const family = taskDefinitionFamily(baseImage(ws.baseImage));
  const taskDims = { ClusterName: cluster, TaskDefinitionFamily: family };
  const insights = cluster === "" ? null : reader;

  const [cpu, memory, diskReadOps, diskWriteOps] = await Promise.all([
    readSeries(
      insights,
      {
        namespace: "ECS/ContainerInsights",
        metricName: "CpuUtilized",
        dimensions: taskDims,
        stat: "Average",
      },
      window,
    ),
    readSeries(
      insights,
      {
        namespace: "ECS/ContainerInsights",
        metricName: "MemoryUtilized",
        dimensions: taskDims,
        stat: "Average",
      },
      window,
    ),
    ws.volumeId === undefined
      ? Promise.resolve<MonitoringSeriesDto>({
          available: false,
          note: "no live volume (scaled to zero) — IOPS resume on next start",
          points: [],
        })
      : readSeries(
          reader,
          {
            namespace: "AWS/EBS",
            metricName: "VolumeReadOps",
            dimensions: { VolumeId: ws.volumeId },
            stat: "Sum",
          },
          window,
        ),
    ws.volumeId === undefined
      ? Promise.resolve<MonitoringSeriesDto>({
          available: false,
          note: "no live volume (scaled to zero) — IOPS resume on next start",
          points: [],
        })
      : readSeries(
          reader,
          {
            namespace: "AWS/EBS",
            metricName: "VolumeWriteOps",
            dimensions: { VolumeId: ws.volumeId },
            stat: "Sum",
          },
          window,
        ),
  ]);

  const body: WorkspaceMonitoringDto = {
    workspaceId: ctx.id,
    state: ws.state,
    resources: sizing,
    uptime: {
      createdAt: ws.createdAt,
      runningMs: session?.runningMs ?? 0,
      stoppedMs: session?.stoppedMs ?? 0,
    },
    ...(session === undefined
      ? {}
      : {
          cost: {
            computeUsd: session.computeUsd,
            volumeUsd: session.volumeUsd,
            snapshotUsd: session.snapshotUsd,
            totalUsd: session.totalUsd,
          },
        }),
    cpu,
    memory,
    diskReadOps,
    diskWriteOps,
    iopsBaseline: GP3_BASELINE_IOPS,
    disk: {
      volumeGib: sizing.volumeGib,
      ...(ws.diskUsedBytes === undefined ? {} : { usedBytes: ws.diskUsedBytes }),
      ...(ws.diskTotalBytes === undefined ? {} : { totalBytes: ws.diskTotalBytes }),
    },
  };
  return NextResponse.json(body);
}

export const GET = withObservability("workspaces.monitoring", handleGET);
