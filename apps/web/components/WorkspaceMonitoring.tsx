// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { MonitoringSeriesDto, WorkspaceMonitoringDto } from "@edd/api-contracts";
import Link from "next/link";
import { useCallback } from "react";

import { TESTID } from "../lib/testids";
import { usePoll } from "../lib/usePoll";
import { gib } from "./WorkspaceInfo";

const api = new ApiClient({ baseUrl: "" });
const POLL_MS = 30_000;

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${String(h)}h ${String(m)}m` : `${String(m)}m`;
}

/** Dependency-free sparkline: scales points into a fixed-size SVG polyline. */
function Sparkline({ series, unit }: { series: MonitoringSeriesDto; unit: string }) {
  const W = 560;
  const H = 80;
  const points = series.points;
  if (!series.available || points.length === 0) {
    return (
      <p className="state-note" style={{ margin: "6px 0" }}>
        {series.note}
      </p>
    );
  }
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1e-9);
  const step = points.length > 1 ? W / (points.length - 1) : W;
  const path = points
    .map((p, i) => `${String(i * step)},${String(H - (p.value / max) * (H - 6) - 2)}`)
    .join(" ");
  const latest = values[values.length - 1] ?? 0;
  return (
    <figure style={{ margin: "6px 0" }}>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label={`latest ${latest.toFixed(1)} ${unit}, peak ${max.toFixed(1)} ${unit}`}
        style={{ width: "100%", maxWidth: W, height: H, display: "block" }}
      >
        <polyline
          points={path}
          fill="none"
          stroke="var(--accent, #9fef00)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="mono" style={{ color: "var(--dim)", fontSize: 11 }}>
        latest {latest.toFixed(1)} {unit} · peak {max.toFixed(1)} {unit} · last 3h
      </figcaption>
    </figure>
  );
}

function MetricPanel({
  title,
  metric,
  series,
  unit,
}: {
  title: string;
  metric: string;
  series: MonitoringSeriesDto;
  unit: string;
}) {
  return (
    <section
      data-testid={TESTID.workspaceMetric}
      data-metric={metric}
      data-available={String(series.available)}
    >
      <h2 style={{ fontSize: 15, marginBottom: 2 }}>{title}</h2>
      <Sparkline series={series} unit={unit} />
    </section>
  );
}

/** Live per-workspace monitoring: sizing, uptime, cost so far (with the snapshot
 * line broken out), utilization + IOPS series. Polls every 30s. */
export function WorkspaceMonitoring({ id }: { id: string }) {
  const load = useCallback(() => api.getWorkspaceMonitoring(id), [id]);
  const { data, error } = usePoll<WorkspaceMonitoringDto>(load, POLL_MS, "monitoring unavailable");

  if (data === null) {
    return error !== null ? (
      <div className="notice" role="alert">
        could not load monitoring: {error}
      </div>
    ) : (
      <p className="state-note" role="status">
        loading monitoring…
      </p>
    );
  }

  const totalMs = data.uptime.runningMs + data.uptime.stoppedMs;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="stack" style={{ gap: 6 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          provisioned
        </div>
        <p className="mono" style={{ margin: 0 }}>
          {data.resources.vcpu} vCPU · {data.resources.memoryGib} GiB memory ·{" "}
          {data.disk.usedBytes !== undefined
            ? `disk ${gib(data.disk.usedBytes)} used of ${String(data.disk.volumeGib)} GiB`
            : `${String(data.disk.volumeGib)} GiB disk`}{" "}
          · {data.iopsBaseline} baseline IOPS (gp3)
        </p>
        <p className="mono" style={{ margin: 0, color: "var(--dim)", fontSize: 12 }}>
          uptime {fmtDuration(data.uptime.runningMs)} running
          {data.uptime.stoppedMs > 0 ? ` · ${fmtDuration(data.uptime.stoppedMs)} paused` : ""}
          {totalMs > 0 ? ` · since ${new Date(data.uptime.createdAt).toLocaleString()}` : ""}
        </p>
      </section>

      <section className="stack" style={{ gap: 6 }}>
        <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
          cost so far
        </div>
        {data.cost === undefined ? (
          <p className="state-note">no priced lifecycle events yet</p>
        ) : (
          <p className="mono" style={{ margin: 0 }}>
            ${data.cost.totalUsd.toFixed(4)} total — compute ${data.cost.computeUsd.toFixed(4)} ·
            volume ${data.cost.volumeUsd.toFixed(4)} · snapshots ${data.cost.snapshotUsd.toFixed(4)}
          </p>
        )}
      </section>

      <MetricPanel title="CPU utilized" metric="cpu" series={data.cpu} unit="vCPU units" />
      <MetricPanel title="Memory utilized" metric="memory" series={data.memory} unit="MiB" />
      <MetricPanel
        title="Disk read ops"
        metric="disk-read-ops"
        series={data.diskReadOps}
        unit="ops / 5min"
      />
      <MetricPanel
        title="Disk write ops"
        metric="disk-write-ops"
        series={data.diskWriteOps}
        unit="ops / 5min"
      />

      <p className="mono" style={{ color: "var(--dim)", fontSize: 11 }}>
        Disk size can be increased by an operator (EBS volume resize); a self-service control is
        planned.{" "}
        <Link href={`/workspaces/${id}`} className="btn" style={{ marginLeft: 8 }}>
          back to session
        </Link>
      </p>
    </div>
  );
}
