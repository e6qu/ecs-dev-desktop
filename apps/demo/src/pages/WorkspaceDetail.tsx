// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";

import { StateBadge } from "../components/StateBadge";
import { AGENT_LABELS, EDITOR_LABELS } from "../lib/demo-types";
import { relTime, usd } from "../lib/format";
import { useDemo } from "../lib/use-demo";

export function WorkspaceDetail(): JSX.Element {
  const cp = useDemo();
  const { id = "" } = useParams();
  const ws = cp.workspaceById(id);

  if (ws === undefined) {
    return (
      <section className="demo-page">
        <p className="demo-empty">
          That workspace doesn’t exist. <Link to="/">Back to workspaces</Link>.
        </p>
      </section>
    );
  }

  const timeline = cp.timelineFor(id);
  const history = cp.auditFor(id);
  const cost = cp.sessionCostFor(id);
  const isOpenable = ws.state === "running" || ws.state === "idle";

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>
          <Link to="/" className="demo-back">
            ← workspaces
          </Link>{" "}
          <code>{ws.id}</code>
        </h2>
        <div className="demo-detail-actions">
          <StateBadge state={ws.state} />
          {isOpenable ? (
            <Link to={`/ide/${ws.id}`} className="demo-primary demo-open">
              Open IDE
            </Link>
          ) : null}
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="num">{ws.baseImage}</div>
          <div className="lbl">Base image</div>
        </div>
        <div className="stat">
          <div className="num">{cost ? usd(cost.totalUsd) : "—"}</div>
          <div className="lbl">Lifetime cost</div>
        </div>
        <div className="stat">
          <div className="num">{EDITOR_LABELS[cp.editorFor(ws.id)]}</div>
          <div className="lbl">Editor</div>
        </div>
        <div className="stat">
          <div className="num">{AGENT_LABELS[cp.agentFor(ws.id)]}</div>
          <div className="lbl">Agent</div>
        </div>
      </div>

      <h3 className="demo-subhead">Lifecycle timeline</h3>
      <ol className="demo-timeline">
        {timeline.map((ev, i) => (
          <li key={`${ev.event}-${String(i)}`} className="demo-timeline-item">
            <span className={`demo-timeline-dot demo-tl-${ev.event}`} />
            <div>
              <div className="demo-timeline-event">{ev.event}</div>
              <div className="meta">
                {ev.detail} · {relTime(ev.at)}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="demo-fine">
        Derived from the workspace record by the real <code>deriveWorkspaceTimeline</code>; on AWS
        the full per-action history is filled from CloudTrail.
      </p>

      <h3 className="demo-subhead">Audit history</h3>
      <ul className="adm-rows">
        {history.map((e, i) => (
          <li key={`${e.action}-${String(i)}`} className="adm-row">
            <div>
              <code>{e.action}</code>
              <div className="meta">{e.detail}</div>
            </div>
            <span className="meta">
              {e.actor} · {relTime(e.at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
