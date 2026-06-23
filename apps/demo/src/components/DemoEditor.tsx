// SPDX-License-Identifier: AGPL-3.0-or-later
import Editor from "@monaco-editor/react";
import { useState, type JSX } from "react";

import type { WorkspaceFiles } from "../lib/ide-files";

// The editor SEAM: an explorer + tabs around a real Monaco editor (bundled, syntax-highlighted,
// multi-file via per-path models). The full vscode-web workbench could later replace the editor
// pane behind this same { files, onSave } interface. Edits persist via onSave.
export function DemoEditor({
  files,
  onSave,
}: {
  files: WorkspaceFiles;
  onSave: (path: string, content: string) => void;
}): JSX.Element {
  const paths = Object.keys(files).sort();
  const [active, setActive] = useState<string>(paths[0] ?? "");
  const content = files[active] ?? "";

  return (
    <div className="ide">
      <aside className="ide-explorer">
        <div className="ide-explorer-head">Explorer</div>
        <ul>
          {paths.map((p) => (
            <li key={p}>
              <button
                type="button"
                className={p === active ? "ide-file active" : "ide-file"}
                onClick={() => {
                  setActive(p);
                }}
              >
                {p}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="ide-main">
        <div className="ide-tabs">
          {active !== "" ? <span className="ide-tab active">{active}</span> : null}
        </div>
        <div className="ide-editor-wrap">
          <Editor
            theme="vs-dark"
            path={active}
            value={content}
            onChange={(v) => {
              onSave(active, v ?? "");
            }}
            loading={<div className="ide-loading">Loading editor…</div>}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              scrollBeyondLastLine: false,
              tabSize: 2,
              automaticLayout: true,
            }}
          />
        </div>
      </div>
    </div>
  );
}
