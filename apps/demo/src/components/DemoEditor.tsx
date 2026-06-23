// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type JSX } from "react";

import type { EditorKind } from "../lib/demo-types";
import type { WorkspaceFiles } from "../lib/ide-files";
import { MonacoPane } from "./MonacoPane";

// The editor SEAM. The environment's editor choice picks the CHROME:
//  - "monaco"     → a lightweight explorer + tabs + Monaco (the first-party lightweight editor).
//  - "openvscode" → a VS Code-style workbench (activity bar, explorer, tabs, status bar) over the
//    SAME Monaco engine, honestly labeled (production runs the server-based OpenVSCode Server).
// Both persist via onSave.
export function DemoEditor({
  files,
  onSave,
  variant,
}: {
  files: WorkspaceFiles;
  onSave: (path: string, content: string) => void;
  variant: EditorKind;
}): JSX.Element {
  const paths = Object.keys(files).sort();
  const [active, setActive] = useState<string>(paths[0] ?? "");
  const content = files[active] ?? "";
  const pane = (
    <MonacoPane
      path={active}
      value={content}
      onChange={(c) => {
        onSave(active, c);
      }}
    />
  );

  const explorer = (
    <ul className="ide-files">
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
  );

  if (variant === "monaco") {
    return (
      <div className="ide ide-monaco">
        <aside className="ide-explorer">
          <div className="ide-explorer-head">Explorer</div>
          {explorer}
        </aside>
        <div className="ide-main">
          <div className="ide-tabs">
            {active !== "" ? <span className="ide-tab active">{active}</span> : null}
          </div>
          <div className="ide-editor-wrap">{pane}</div>
        </div>
      </div>
    );
  }

  // OpenVSCode workbench chrome.
  return (
    <div className="ide ide-workbench">
      <div className="wb-activity">
        <span className="wb-act active" title="Explorer">
          ▤
        </span>
        <span className="wb-act" title="Search">
          ⌕
        </span>
        <span className="wb-act" title="Source control">
          ⎇
        </span>
        <span className="wb-act" title="Extensions">
          ▦
        </span>
      </div>
      <aside className="ide-explorer">
        <div className="ide-explorer-head">Explorer — workspace</div>
        {explorer}
      </aside>
      <div className="ide-main">
        <div className="ide-tabs">
          {active !== "" ? <span className="ide-tab active">{active}</span> : null}
        </div>
        <div className="ide-editor-wrap">{pane}</div>
        <div className="wb-status">
          <span>OpenVSCode</span>
          <span className="wb-status-spacer" />
          <span>{active}</span>
          <span>UTF-8</span>
          <span>Spaces: 2</span>
        </div>
      </div>
    </div>
  );
}
