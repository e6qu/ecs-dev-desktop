// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";

import type { WorkspaceFiles } from "../lib/ide-files";

// The editor SEAM. v0 is a deliberately small explorer + tabs + edit pane (zero new deps) —
// the full vscode-web workbench (or Monaco) drops in behind this same { files, onSave }
// interface without touching the rest of the app. Files persist via onSave.
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
        <textarea
          className="ide-editor"
          value={content}
          spellCheck={false}
          onChange={(e) => {
            onSave(active, e.target.value);
          }}
          aria-label={`editor: ${active}`}
        />
      </div>
    </div>
  );
}
