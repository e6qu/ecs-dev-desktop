// SPDX-License-Identifier: AGPL-3.0-or-later
import Editor from "@monaco-editor/react";
import type { JSX } from "react";

// The shared editor engine (real, bundled Monaco). Both editor variants — the lightweight
// Monaco offering and the OpenVSCode workbench chrome — render this pane.
export function MonacoPane({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (content: string) => void;
}): JSX.Element {
  return (
    <Editor
      theme="vs-dark"
      path={path}
      value={value}
      onChange={(v) => {
        onChange(v ?? "");
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
  );
}
