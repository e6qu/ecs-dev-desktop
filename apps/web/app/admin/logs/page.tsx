// SPDX-License-Identifier: AGPL-3.0-or-later
import { taskId as toTaskId, workspaceId, type LogReadFilter, type LogStream } from "@edd/core";

import { isAdminViewer } from "../../../lib/principal";
import { getAuditSource, getControlPlane, getLogSource } from "../../../lib/control-plane";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

// The control-plane stream is derived now; the rest light up on AWS.
const LOG_STREAMS: LogStream[] = ["control-plane", "reconciler", "container"];

// Admin-only (the /admin layout gates it). Derived audit feed + log streams.
// `?workspaceId=ws-…` narrows the container stream to one workspace's task logs.
export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  if (!(await isAdminViewer())) return null;
  const { workspaceId: wsId } = await searchParams;
  const logSource = getLogSource();

  // Resolve the workspace's task to a per-workspace container-log filter.
  let filter: LogReadFilter | undefined;
  if (wsId !== undefined && wsId.length > 0) {
    const detail = await (await getControlPlane()).inspect(workspaceId(wsId));
    const wsTaskId = detail?.workspace.taskId;
    if (wsTaskId !== undefined) filter = { taskId: toTaskId(wsTaskId) };
  }

  const [events, streams] = await Promise.all([
    getAuditSource().recent(),
    Promise.all(LOG_STREAMS.map((s) => logSource.read(s, s === "container" ? filter : undefined))),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">troubleshooting</div>
          <h1>Logs &amp; audit</h1>
          <p>
            Audit is <strong>derived from current state</strong> now and comes from CloudTrail on
            AWS; container, app, and reconciler logs stream from CloudWatch once deployed.
          </p>
          {wsId !== undefined && wsId.length > 0 && (
            <p className="mono" style={{ color: "var(--dim)", fontSize: 11 }}>
              container stream filtered to workspace <strong>{wsId}</strong>
              {filter === undefined ? " (no running task — showing none)" : ""}
            </p>
          )}
        </div>
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Audit feed</h2>
      <p className="mono" style={{ color: "var(--dimmer)", fontSize: 11, marginBottom: 10 }}>
        derived from workspace records — durable, actor-attributed history via CloudTrail on AWS
      </p>
      {events.length === 0 ? (
        <p className="state-note">no audit events yet</p>
      ) : (
        <div className="audit-feed" style={{ marginBottom: 28 }}>
          {events.map((e, i) => (
            <div
              key={`${e.target}-${e.at}-${i.toString()}`}
              className="audit-row"
              data-testid={TESTID.auditRow}
              data-action={e.action}
            >
              <span className="when">{new Date(e.at).toLocaleString()}</span>
              <span className="action">{e.action}</span>
              <span className="target mono">{e.target}</span>
              <span className="detail">{e.detail}</span>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginBottom: 10 }}>Log streams</h2>
      <div className="adm-rows">
        {streams.map((s) => (
          <div
            key={s.stream}
            className="panel"
            data-testid={TESTID.logStream}
            data-stream={s.stream}
            data-available={s.available}
          >
            <div className="stream-head">
              <span className="mono stream-name">{s.stream}</span>
              <span className={`pill ${s.available ? "on" : "off"}`}>
                {s.available ? "live" : "on AWS"}
              </span>
            </div>
            <p className="mono" style={{ color: "var(--dimmer)", fontSize: 11, margin: "2px 0 0" }}>
              {s.note}
            </p>
            {s.available && s.lines.length > 0 && (
              <pre className="log-pane">
                {s.lines.map((l, i) => (
                  <div key={`${l.source}-${l.at}-${i.toString()}`} className="log-line">
                    <span className="ts">{new Date(l.at).toLocaleTimeString()}</span>
                    <span className={`lvl lvl-${l.level}`}>{l.level}</span>
                    <span className="msg">{l.message}</span>
                  </div>
                ))}
              </pre>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
