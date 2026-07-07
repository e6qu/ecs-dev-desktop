// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { StatusBadge } from "../../../../components/StatusBadge";
import { SnapshotIntervalControl } from "../../../../components/SnapshotIntervalControl";
import { WorkspaceActions } from "../../../../components/WorkspaceActions";
import { getCatalog, getControlPlane } from "../../../../lib/control-plane";
import { TESTID } from "../../../../lib/testids";
import { catalogByImage } from "../../../../lib/workspace-enrich";

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: ReactNode | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? "—"}</dd>
    </>
  );
}

export default async function InspectWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cp = await getControlPlane();
  const [inspection, catalog] = await Promise.all([
    cp.inspect(workspaceId(id)),
    getCatalog().list(),
  ]);
  if (inspection === null) notFound();
  const { workspace: ws, timeline } = inspection;
  const entry = catalogByImage(catalog).get(ws.baseImage);
  const imageName = entry?.name ?? ws.baseImage;
  const imageDescription = entry?.description ?? "";
  const imageTags = entry?.tags ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">
            <Link href="/admin/workspaces">admin / workspaces</Link>
          </div>
          <h1>Inspect</h1>
          <p className="mono" style={{ color: "var(--dim)" }}>
            {ws.id}
          </p>
        </div>
        <StatusBadge state={ws.state} />
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <dl className="kv">
          <Row label="owner" value={ws.ownerId} />
          <Row label="environment" value={imageName} />
          <Row label="image ref" value={ws.baseImage} />
          <Row label="description" value={imageDescription === "" ? undefined : imageDescription} />
          <Row label="created" value={new Date(ws.createdAt).toLocaleString()} />
          <Row label="last activity" value={new Date(ws.lastActivity).toLocaleString()} />
          <Row label="task" value={ws.taskId} />
          <Row label="volume" value={ws.volumeId} />
          <Row
            label="monitoring"
            value={<Link href={`/workspaces/${ws.id}/monitoring`}>open monitoring</Link>}
          />
          <Row
            label="snapshot interval"
            value={
              ws.snapshotIntervalMs === undefined
                ? undefined
                : `${String(Math.round(ws.snapshotIntervalMs / 60000))} min`
            }
          />
          <Row label="latest snapshot" value={ws.latestSnapshotId} />
          <Row
            label="snapshot at"
            value={ws.latestSnapshotAt ? new Date(ws.latestSnapshotAt).toLocaleString() : undefined}
          />
          <Row
            label="usable"
            value={
              ws.functional === undefined
                ? undefined
                : `${ws.functional === "ok" ? "✓" : "✗"} ${ws.functionalDetail ?? ws.functional}${
                    ws.functionalAt ? ` (${new Date(ws.functionalAt).toLocaleString()})` : ""
                  }`
            }
          />
        </dl>
        <div style={{ marginTop: 16 }}>
          <SnapshotIntervalControl id={ws.id} valueMs={ws.snapshotIntervalMs} />
        </div>
        {imageTags.length > 0 && (
          <div className="pill-row" style={{ marginTop: 16 }}>
            {imageTags.map((tag) => (
              <span key={tag} className="pill">
                {tag}
              </span>
            ))}
          </div>
        )}
        <WorkspaceActions id={ws.id} actions={ws.availableActions} />
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Lifecycle</h2>
      <p className="mono" style={{ color: "var(--dimmer)", fontSize: 11, marginBottom: 8 }}>
        derived from the current record — full per-action history via CloudTrail on AWS
      </p>
      <div className="timeline">
        {[...timeline].reverse().map((e, i) => (
          <div
            key={`${e.at}-${i.toString()}`}
            className="tl-row"
            data-testid={TESTID.timelineRow}
            data-event={e.event}
          >
            <span className="when">{new Date(e.at).toLocaleString()}</span>
            <span className="what">{e.event}</span>
            <span className="why">{e.detail}</span>
          </div>
        ))}
      </div>
    </>
  );
}
