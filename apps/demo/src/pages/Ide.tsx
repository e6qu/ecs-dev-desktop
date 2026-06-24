// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type JSX } from "react";
import { Link, useParams } from "react-router-dom";

import { AgentPanel } from "../components/AgentPanel";
import { DemoEditor } from "../components/DemoEditor";
import { AGENT_LABELS, EDITOR_LABELS } from "../lib/demo-types";
import { loadFiles, saveFile, type WorkspaceFiles } from "../lib/ide-files";
// Side-effect: bundle + configure Monaco. Imported here (not in main) so it lands in the
// lazy-loaded IDE chunk — the other pages don't pay Monaco's ~4 MB.
import "../lib/monaco-setup";
import { useDemo } from "../lib/use-demo";

export function Ide(): JSX.Element {
  const cp = useDemo();
  const { id = "" } = useParams();
  const ws = cp.workspaces().find((w) => w.id === id);
  const baseImage = ws?.baseImage;

  // IDE files live in IndexedDB (async), so load them after mount; null = still loading.
  const [files, setFiles] = useState<WorkspaceFiles | null>(null);
  useEffect(() => {
    if (baseImage === undefined) return;
    let active = true;
    void loadFiles(id, baseImage).then((f) => {
      if (active) setFiles(f);
    });
    return () => {
      active = false;
    };
  }, [id, baseImage]);

  if (ws === undefined) {
    return (
      <section className="demo-page">
        <p className="demo-empty">
          That workspace doesn’t exist. <Link to="/">Back to workspaces</Link>.
        </p>
      </section>
    );
  }

  if (files === null) {
    return (
      <section className="demo-page">
        <p className="demo-empty">Loading workspace…</p>
      </section>
    );
  }

  const onSave = (path: string, content: string): void => {
    void saveFile(id, path, content);
    setFiles((prev) => (prev === null ? prev : { ...prev, [path]: content }));
  };

  const editor = cp.editorFor(ws.id);
  const agent = cp.agentFor(ws.id);

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>
          <Link to="/" className="demo-back">
            ← workspaces
          </Link>{" "}
          <code>{ws.id}</code>
        </h2>
        <span className="meta">
          {ws.baseImage} · {EDITOR_LABELS[editor]} · {AGENT_LABELS[agent]}
        </span>
      </div>
      <DemoEditor files={files} onSave={onSave} variant={editor} />
      <AgentPanel agent={agent} files={files} />
      <p className="demo-fine">
        {editor === "openvscode"
          ? "OpenVSCode — the full IDE (the static demo previews the workbench over a real Monaco engine)."
          : "Monaco — the lightweight first-party editor (real, bundled)."}{" "}
        The agent panel runs a scripted {AGENT_LABELS[agent]} session; everything persists locally
        and is cleared on reset.
      </p>
    </section>
  );
}
