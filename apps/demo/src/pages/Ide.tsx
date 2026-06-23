// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";
import { Link, useParams } from "react-router-dom";

import { DemoEditor } from "../components/DemoEditor";
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

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>
          <Link to="/" className="demo-back">
            ← workspaces
          </Link>{" "}
          <code>{ws.id}</code>
        </h2>
        <span className="meta">{ws.baseImage}</span>
      </div>
      <DemoEditor files={files} onSave={onSave} />
      <p className="demo-fine">
        Editor v0 — edits persist locally (cleared on reset). The full in-browser VS Code workbench
        drops in behind this same component once its dependency surface is approved.
      </p>
    </section>
  );
}
