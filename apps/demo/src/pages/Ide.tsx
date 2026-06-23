// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";
import { Link, useParams } from "react-router-dom";

import { DemoEditor } from "../components/DemoEditor";
import { EDITOR_LABELS } from "../lib/demo-types";
import { filesFor, saveFile, type WorkspaceFiles } from "../lib/ide-files";
// Side-effect: bundle + configure Monaco. Imported here (not in main) so it lands in the
// lazy-loaded IDE chunk — the other pages don't pay Monaco's ~4 MB.
import "../lib/monaco-setup";
import { useDemo } from "../lib/use-demo";

export function Ide(): JSX.Element {
  const cp = useDemo();
  const { id = "" } = useParams();
  const ws = cp.workspaces().find((w) => w.id === id);

  const [files, setFiles] = useState<WorkspaceFiles>(() =>
    ws ? filesFor(ws.id, ws.baseImage) : {},
  );

  if (ws === undefined) {
    return (
      <section className="demo-page">
        <p className="demo-empty">
          That workspace doesn’t exist. <Link to="/">Back to workspaces</Link>.
        </p>
      </section>
    );
  }

  const onSave = (path: string, content: string): void => {
    saveFile(ws.id, path, content);
    setFiles((prev) => ({ ...prev, [path]: content }));
  };

  const editor = cp.editorFor(ws.id);

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
          {ws.baseImage} · {EDITOR_LABELS[editor]}
        </span>
      </div>
      <DemoEditor files={files} onSave={onSave} variant={editor} />
      <p className="demo-fine">
        {editor === "openvscode"
          ? "OpenVSCode — the full IDE. In production this environment runs OpenVSCode Server; this static demo previews the workbench over a real Monaco engine. Edits persist locally (cleared on reset)."
          : "Monaco — the lightweight first-party editor (real, bundled). Edits persist locally (cleared on reset)."}
      </p>
    </section>
  );
}
