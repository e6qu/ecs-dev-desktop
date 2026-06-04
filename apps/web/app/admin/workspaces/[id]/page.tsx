// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StatusBadge } from "../../../../components/StatusBadge";
import { WorkspaceActions } from "../../../../components/WorkspaceActions";
import { getControlPlane } from "../../../../lib/control-plane";

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: string | undefined }) {
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
  const inspection = await cp.inspect(workspaceId(id));
  if (inspection === null) notFound();
  const { workspace: ws, timeline } = inspection;

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
          <Row label="base image" value={ws.baseImage} />
          <Row label="created" value={new Date(ws.createdAt).toLocaleString()} />
          <Row label="last activity" value={new Date(ws.lastActivity).toLocaleString()} />
          <Row label="task" value={ws.taskId} />
          <Row label="volume" value={ws.volumeId} />
          <Row label="latest snapshot" value={ws.latestSnapshotId} />
          <Row
            label="snapshot at"
            value={ws.latestSnapshotAt ? new Date(ws.latestSnapshotAt).toLocaleString() : undefined}
          />
        </dl>
        <WorkspaceActions id={ws.id} state={ws.state} />
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Lifecycle</h2>
      <p className="mono" style={{ color: "var(--dimmer)", fontSize: 11, marginBottom: 8 }}>
        derived from the current record — full per-action history via CloudTrail on AWS
      </p>
      <div className="timeline">
        {[...timeline].reverse().map((e, i) => (
          <div key={`${e.at}-${i.toString()}`} className="tl-row">
            <span className="when">{new Date(e.at).toLocaleString()}</span>
            <span className="what">{e.event}</span>
            <span className="why">{e.detail}</span>
          </div>
        ))}
      </div>
    </>
  );
}
