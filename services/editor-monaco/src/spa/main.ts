// SPDX-License-Identifier: AGPL-3.0-or-later
// The Monaco SPA: a file tree + a Monaco editor over the server's confined file API. Vanilla TS
// (no framework) — the "lightweight first-party editor". Served under /w/<id>/; all fetches are
// relative to the document, so they ride the proxy to this workspace's editor server.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import "@xterm/xterm/css/xterm.css";
import "./editor.css";

const WORKER_BY_LABEL: Record<string, () => Worker> = {
  json: () => new jsonWorker(),
  typescript: () => new tsWorker(),
  javascript: () => new tsWorker(),
};
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string): Worker =>
    (WORKER_BY_LABEL[label] ?? (() => new editorWorker()))(),
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
  const filesEl = el("files");
  const res = await fetch("api/tree");
  if (!res.ok) {
    filesEl.textContent = `could not load files (${String(res.status)})`;
    return;
  }
  const raw: unknown = await res.json();
  filesEl.replaceChildren();
  for (const entry of parseEntries(raw)) {
    const pad = `${String(12 + (entry.path.split("/").length - 1) * 12)}px`;
    const label = (entry.type === "dir" ? "▸ " : "") + (entry.path.split("/").pop() ?? entry.path);
    if (entry.type === "dir") {
      // Directories are not openable yet — render an inert label, not a dead focusable button.
      const dir = document.createElement("div");
      dir.className = "file-row dir";
      dir.style.paddingLeft = pad;
      dir.textContent = label;
      filesEl.append(dir);
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row";
    row.style.paddingLeft = pad;
    row.textContent = label;
    row.addEventListener("click", () => {
      void openFile(entry.path, row);
    });
    filesEl.append(row);
  }
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  void save();
});

// ── terminal (xterm over the server's PTY WebSocket) ──
let term: Terminal | null = null;

function setupTerminal(): void {
  if (term !== null) return;
  const t = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: "#1e1e1e" } });
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open(el("terminal"));
  fit.fit();

  const wsUrl = new URL("terminal", document.baseURI);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(wsUrl);
  sock.addEventListener("open", () => {
    sock.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
  });
  sock.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") t.write(e.data);
  });
  sock.addEventListener("error", () => {
    t.write("\r\n\x1b[31m[terminal connection error]\x1b[0m\r\n");
  });
  sock.addEventListener("close", () => {
    t.write("\r\n\x1b[33m[terminal disconnected]\x1b[0m\r\n");
  });
  t.onData((data) => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "input", data }));
  });
  t.onResize(({ cols, rows }) => {
    if (sock.readyState === WebSocket.OPEN)
      sock.send(JSON.stringify({ type: "resize", cols, rows }));
  });
  window.addEventListener("resize", () => {
    fit.fit();
  });
  term = t;
}

el("toggle-terminal").addEventListener("click", () => {
  const panel = el("terminal-panel");
  const show = panel.hidden;
  panel.hidden = !show;
  if (show) {
    setupTerminal();
    term?.focus();
  }
});

void loadTree();
