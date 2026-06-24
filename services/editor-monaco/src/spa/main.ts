// SPDX-License-Identifier: AGPL-3.0-or-later
// The Monaco SPA: a file tree + a Monaco editor over the server's confined file API. Vanilla TS
// (no framework) — the "lightweight first-party editor". Served under /w/<id>/; all fetches are
// relative to the document, so they ride the proxy to this workspace's editor server.
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import "./editor.css";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") return new jsonWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  css: "css",
  html: "html",
  sh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
};

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

function languageFor(filePath: string): string {
  return LANG[filePath.split(".").pop() ?? ""] ?? "plaintext";
}

/** `Array.isArray` widens `unknown` to `any[]`; this guard keeps elements `unknown`. */
function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Narrow the /api/tree response without unsafe casts. */
function parseEntries(raw: unknown): TreeEntry[] {
  if (typeof raw !== "object" || raw === null || !("entries" in raw)) return [];
  if (!isUnknownArray(raw.entries)) return [];
  return raw.entries.filter(
    (e): e is TreeEntry =>
      typeof e === "object" &&
      e !== null &&
      "path" in e &&
      "type" in e &&
      typeof e.path === "string" &&
      (e.type === "file" || e.type === "dir"),
  );
}

function flash(message: string): void {
  const status = el("status");
  status.textContent = message;
  status.classList.add("show");
  window.setTimeout(() => {
    status.classList.remove("show");
  }, 1200);
}

const editor = monaco.editor.create(el("editor"), {
  value: "",
  language: "plaintext",
  theme: "vs-dark",
  automaticLayout: true,
  minimap: { enabled: false },
  readOnly: true,
});

let currentPath: string | null = null;

async function openFile(filePath: string, row: HTMLElement): Promise<void> {
  const res = await fetch(`api/file?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    flash(`open failed: ${String(res.status)}`);
    return;
  }
  const text = await res.text();
  currentPath = filePath;
  el("current-file").textContent = filePath;
  const model = editor.getModel();
  if (model !== null) monaco.editor.setModelLanguage(model, languageFor(filePath));
  editor.setValue(text);
  editor.updateOptions({ readOnly: false });
  for (const r of document.querySelectorAll(".file-row.active")) r.classList.remove("active");
  row.classList.add("active");
}

async function save(): Promise<void> {
  if (currentPath === null) return;
  const res = await fetch(`api/file?path=${encodeURIComponent(currentPath)}`, {
    method: "PUT",
    body: editor.getValue(),
  });
  flash(res.ok ? "saved" : `save failed: ${String(res.status)}`);
}

async function loadTree(): Promise<void> {
  const res = await fetch("api/tree");
  const raw: unknown = await res.json();
  const filesEl = el("files");
  filesEl.replaceChildren();
  for (const entry of parseEntries(raw)) {
    const depth = entry.path.split("/").length - 1;
    const row = document.createElement("button");
    row.type = "button";
    row.className = entry.type === "dir" ? "file-row dir" : "file-row";
    row.style.paddingLeft = `${String(12 + depth * 12)}px`;
    row.textContent =
      (entry.type === "dir" ? "▸ " : "") + (entry.path.split("/").pop() ?? entry.path);
    if (entry.type === "file") {
      row.addEventListener("click", () => {
        void openFile(entry.path, row);
      });
    }
    filesEl.append(row);
  }
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  void save();
});

void loadTree();
