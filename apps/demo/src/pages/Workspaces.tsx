// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";

import { baseImage, type Workspace, type WorkspaceAction } from "@edd/core";

import { StateBadge } from "../components/StateBadge";
import { relTime } from "../lib/format";
import { useDemo } from "../lib/use-demo";

export function Workspaces(): JSX.Element {
  const cp = useDemo();
  const catalog = cp.catalog();
  const [picked, setPicked] = useState<string>(catalog[0]?.image ?? "");
  const mine = [...cp.workspaces({ mine: true })].sort(
    (a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
  );

  const runAction = (ws: Workspace, action: WorkspaceAction): void => {
    if (action === "stop") cp.stop(ws.id);
    else if (action === "start") cp.start(ws.id);
    else if (action === "delete") cp.remove(ws.id);
  };

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>Your workspaces</h2>
        <form
          className="demo-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (picked !== "") cp.create(baseImage(picked));
          }}
        >
          <select
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
            }}
            aria-label="Base image"
          >
            {catalog.map((c) => (
              <option key={c.id} value={c.image}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="submit" className="demo-primary">
            + New workspace
          </button>
        </form>
      </div>

      {mine.length === 0 ? (
        <p className="demo-empty">No workspaces yet — create one from a base image above.</p>
      ) : (
        <ul className="demo-ws-list">
          {mine.map((ws) => (
            <li key={ws.id} className="demo-ws">
              <div className="demo-ws-main">
                <StateBadge state={ws.state} />
                <div>
                  <div className="demo-ws-name">{ws.id}</div>
                  <div className="demo-ws-meta">
                    {ws.baseImage} · active {relTime(ws.lastActivity)}
                  </div>
                </div>
              </div>
              <div className="demo-ws-actions">
                {cp.actionsFor(ws).map((a) =>
                  a === "snapshot" ? null : (
                    <button
                      key={a}
                      type="button"
                      className={a === "delete" ? "demo-danger" : "demo-ghost"}
                      onClick={() => {
                        runAction(ws, a);
                      }}
                    >
                      {a}
                    </button>
                  ),
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
