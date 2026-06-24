// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";
import { Link } from "react-router-dom";

import { baseImage, type WorkspaceAction } from "@edd/core";

import { StateBadge } from "../components/StateBadge";
import { AGENT_LABELS, EDITOR_LABELS, type AgentKind, type EditorKind } from "../lib/demo-types";
import { relTime } from "../lib/format";
import { useDemo } from "../lib/use-demo";

export function Workspaces(): JSX.Element {
  const cp = useDemo();
  const catalog = cp.catalog();
  const [picked, setPicked] = useState<string>(catalog[0]?.image ?? "");
  const [editor, setEditor] = useState<EditorKind>("openvscode");
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  // Deleting a workspace is irreversible, so (like SSH-key removal) it takes a second click.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const mine = [...cp.workspaces({ mine: true })].sort(
    (a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
  );

  const ACTION_LABEL: Record<WorkspaceAction, string> = {
    start: "Start",
    stop: "Stop",
    snapshot: "Snapshot",
    delete: "Delete",
  };

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>Your workspaces</h2>
        <form
          className="demo-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (picked !== "") cp.create(baseImage(picked), editor, agent);
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
          <select
            value={editor}
            onChange={(e) => {
              if (e.target.value === "monaco" || e.target.value === "openvscode") {
                setEditor(e.target.value);
              }
            }}
            aria-label="Editor"
          >
            <option value="openvscode">OpenVSCode</option>
            <option value="monaco">Monaco</option>
          </select>
          <select
            value={agent}
            onChange={(e) => {
              if (e.target.value === "claude-code" || e.target.value === "codex") {
                setAgent(e.target.value);
              }
            }}
            aria-label="Agent"
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
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
                  <Link to={`/workspace/${ws.id}`} className="demo-ws-name demo-ws-link">
                    {ws.id}
                  </Link>
                  <div className="demo-ws-meta">
                    {ws.baseImage} ·{" "}
                    <span className="demo-editor-tag">{EDITOR_LABELS[cp.editorFor(ws.id)]}</span> ·{" "}
                    <span className="demo-agent-tag">{AGENT_LABELS[cp.agentFor(ws.id)]}</span> ·
                    active {relTime(ws.lastActivity)}
                  </div>
                </div>
              </div>
              <div className="demo-ws-actions">
                {ws.state === "running" || ws.state === "idle" ? (
                  <Link to={`/ide/${ws.id}`} className="demo-primary demo-open">
                    Open IDE
                  </Link>
                ) : null}
                {cp.actionsFor(ws).map((a) => {
                  if (a === "snapshot") return null;
                  if (a === "delete") {
                    const armed = confirmingDelete === ws.id;
                    return (
                      <button
                        key={a}
                        type="button"
                        className="demo-danger"
                        onClick={() => {
                          if (armed) {
                            cp.remove(ws.id);
                            setConfirmingDelete(null);
                          } else {
                            setConfirmingDelete(ws.id);
                          }
                        }}
                      >
                        {armed ? "Confirm delete" : "Delete"}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={a}
                      type="button"
                      className="demo-ghost"
                      onClick={() => {
                        if (a === "stop") cp.stop(ws.id);
                        else cp.start(ws.id);
                      }}
                    >
                      {ACTION_LABEL[a]}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
