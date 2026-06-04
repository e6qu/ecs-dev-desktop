// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LogStream } from "@edd/core";

import { getAuditSource, getLogSource } from "../../../lib/control-plane";

export const dynamic = "force-dynamic";

// The control-plane stream is derived now; the rest light up on AWS.
const LOG_STREAMS: LogStream[] = ["control-plane", "reconciler", "container"];

// Admin-only (the /admin layout gates it). Derived audit feed + log streams.
export default async function AdminLogsPage() {
  const logSource = getLogSource();
  const [events, streams] = await Promise.all([
    getAuditSource().recent(),
    Promise.all(LOG_STREAMS.map((s) => logSource.read(s))),
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
        </div>
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Audit feed</h2>
      <p className="mono" style={{ color: "var(--dimmer)", fontSize: 11, marginBottom: 10 }}>
        derived from workspace records — durable, actor-attributed history via CloudTrail on AWS
      </p>
      {events.length === 0 ? (
        <p className="mono" style={{ color: "var(--dim)" }}>
          no audit events yet
        </p>
      ) : (
        <div className="audit-feed" style={{ marginBottom: 28 }}>
          {events.map((e, i) => (
            <div key={`${e.target}-${e.at}-${i.toString()}`} className="audit-row">
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
          <div key={s.stream} className="panel" data-stream={s.stream}>
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
