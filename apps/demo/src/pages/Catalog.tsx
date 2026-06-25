// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";
import { useNavigate } from "react-router-dom";

import { baseImage } from "@edd/core";

import { AGENT_LABELS, EDITOR_LABELS, type AgentKind, type EditorKind } from "../lib/demo-types";
import { useDemo } from "../lib/use-demo";

export function Catalog(): JSX.Element {
  const cp = useDemo();
  const navigate = useNavigate();
  const [editor, setEditor] = useState<EditorKind>("openvscode");
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const canMutate = cp.canMutateWorkspaces(); // a viewer is read-only — no create control

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>Base-image catalog</h2>
        {!canMutate && <span className="demo-readonly-note">viewer — browse only</span>}
        {/* The editor/agent pickers only feed `create`, so they're hidden for a read-only viewer. */}
        {canMutate && (
          <>
            <label className="demo-user">
              <span>editor</span>
              <select
                value={editor}
                onChange={(e) => {
                  if (e.target.value === "monaco" || e.target.value === "openvscode") {
                    setEditor(e.target.value);
                  }
                }}
              >
                <option value="openvscode">{EDITOR_LABELS.openvscode}</option>
                <option value="monaco">{EDITOR_LABELS.monaco}</option>
              </select>
            </label>
            <label className="demo-user">
              <span>agent</span>
              <select
                value={agent}
                onChange={(e) => {
                  if (e.target.value === "claude-code" || e.target.value === "codex") {
                    setAgent(e.target.value);
                  }
                }}
              >
                <option value="claude-code">{AGENT_LABELS["claude-code"]}</option>
                <option value="codex">{AGENT_LABELS.codex}</option>
              </select>
            </label>
          </>
        )}
      </div>
      <p className="demo-fine">
        Curated golden images. Pick an editor and launch one to create a workspace. OpenVSCode is
        the full IDE; Monaco is the lightweight first-party editor.
      </p>
      <div className="demo-catalog">
        {cp.catalog().map((c) => (
          <div key={c.id} className="demo-card">
            <div className="demo-card-head">
              <h3>{c.name}</h3>
              <code className="meta">{c.image}</code>
            </div>
            <p className="demo-card-desc">{c.description}</p>
            <div className="demo-tools">
              {c.tools.map((t) => (
                <span key={t} className="demo-chip">
                  {t}
                </span>
              ))}
            </div>
            {canMutate && (
              <button
                type="button"
                className="demo-primary"
                onClick={() => {
                  cp.create(baseImage(c.image), editor, agent);
                  void navigate("/");
                }}
              >
                + New workspace
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
