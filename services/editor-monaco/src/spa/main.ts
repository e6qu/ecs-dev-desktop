// SPDX-License-Identifier: AGPL-3.0-or-later
// The Monaco SPA: a file tree + a Monaco editor over the server's confined file API. Vanilla TS
// (no framework) — the "lightweight first-party editor". Served under /w/<id>/; all fetches are
// relative to the document, so they ride the proxy to this workspace's editor server.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import * as monaco from "monaco-editor";

import {
  captureFileOpened,
  captureTabs,
  captureTermOutput,
  initSpectateCapture,
} from "./spectate-capture";
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
});

let currentPath: string | null = null;
let currentTreeSignature = "";

initSpectateCapture({ editor, getCurrentPath: () => currentPath });

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
  // Programmatic load, not a user edit -- must not trigger the autosave below.
  loadingFile = true;
  editor.setValue(text);
  loadingFile = false;
  for (const r of document.querySelectorAll(".file-row.active")) r.classList.remove("active");
  row.classList.add("active");
  captureFileOpened();
}

async function createFile(): Promise<void> {
  const suggested = currentPath === null ? "hello.txt" : "new-file.txt";
  const raw = window.prompt("New file path", suggested);
  const filePath = raw?.trim();
  if (filePath === undefined || filePath === "") return;
  const res = await fetch(`api/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: "",
  });
  if (!res.ok) {
    flash(`create failed: ${String(res.status)}`);
    return;
  }
  await loadTree({ force: true, openPath: filePath });
}

async function save(): Promise<void> {
  if (currentPath === null) return;
  const res = await fetch(`api/file?path=${encodeURIComponent(currentPath)}`, {
    method: "PUT",
    body: editor.getValue(),
  });
  flash(res.ok ? "saved" : `save failed: ${String(res.status)}`);
}

async function loadTree(opts: { force?: boolean; openPath?: string } = {}): Promise<void> {
  const filesEl = el("files");
  const res = await fetch("api/tree");
  if (!res.ok) {
    filesEl.textContent = `could not load files (${String(res.status)})`;
    return;
  }
  const raw: unknown = await res.json();
  const entries = parseEntries(raw);
  const signature = JSON.stringify(entries);
  if (opts.force !== true && signature === currentTreeSignature) return;
  currentTreeSignature = signature;
  filesEl.replaceChildren();
  let rowToOpen: HTMLElement | null = null;
  const openPath = opts.openPath;
  for (const entry of entries) {
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
    if (entry.path === currentPath) row.classList.add("active");
    if (openPath !== undefined && entry.path === openPath) rowToOpen = row;
    filesEl.append(row);
  }
  if (rowToOpen !== null && openPath !== undefined) await openFile(openPath, rowToOpen);
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  void save();
});

// Autosave (default-on, matching the OpenVSCode variant's files.autoSave):
// debounce a save shortly after the user stops typing. Ctrl/Cmd+S still forces
// an immediate save.
const AUTOSAVE_DELAY_MS = 1000;
let autosaveTimer: number | undefined;
let loadingFile = false;
editor.onDidChangeModelContent(() => {
  if (currentPath === null || loadingFile) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    void save();
  }, AUTOSAVE_DELAY_MS);
});

// ── terminal (xterm over the server's PTY WebSocket) — multiple concurrent tabs,
// each its own PTY (the server spawns one per WebSocket connection, so opening a
// second tab is just opening a second connection). Starts open with one tab by
// default; Ctrl+`/Cmd+` toggles the panel, +Shift opens a new tab — the same
// keybinding convention as VS Code, shown as a hint on the toggle button.
interface TerminalTab {
  id: number;
  term: Terminal;
  fit: FitAddon;
  sock: WebSocket;
  pane: HTMLElement;
  tabButton: HTMLElement;
}

const tabs: TerminalTab[] = [];
let activeTabId: number | null = null;
let nextTabId = 1;

function activateTab(id: number): void {
  activeTabId = id;
  for (const t of tabs) {
    const isActive = t.id === id;
    t.pane.hidden = !isActive;
    t.tabButton.classList.toggle("active", isActive);
    t.tabButton.setAttribute("aria-selected", String(isActive));
  }
  const active = tabs.find((t) => t.id === id);
  active?.fit.fit();
  active?.term.focus();
}

function openNewTerminalTab(): void {
  const id = nextTabId++;
  const pane = document.createElement("div");
  pane.className = "terminal-pane";
  pane.hidden = true;
  el("terminal-panes").append(pane);

  const tabButton = document.createElement("button");
  tabButton.type = "button";
  tabButton.className = "terminal-tab";
  tabButton.setAttribute("role", "tab");
  tabButton.textContent = String(tabs.length + 1);
  tabButton.addEventListener("click", () => {
    activateTab(id);
  });
  el("new-terminal-tab").before(tabButton);

  const t = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: "#1e1e1e" } });
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open(pane);

  const wsUrl = new URL("terminal", document.baseURI);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(wsUrl);
  sock.addEventListener("open", () => {
    sock.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
  });
  sock.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") {
      t.write(e.data);
      // Spectate mirror: forwarded live-only while the owner shares (no-op otherwise).
      captureTermOutput(id, e.data);
    }
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

  tabs.push({ id, term: t, fit, sock, pane, tabButton });
  activateTab(id);
  captureTabs(tabs.length, id);
}

function setTerminalPanelVisible(show: boolean): void {
  const panel = el("terminal-panel");
  panel.hidden = !show;
  el("toggle-terminal").setAttribute("aria-expanded", String(show));
  if (show) {
    if (tabs.length === 0) openNewTerminalTab();
    else if (activeTabId !== null) activateTab(activeTabId);
  }
}

window.addEventListener("resize", () => {
  tabs.find((t) => t.id === activeTabId)?.fit.fit();
});

el("toggle-terminal").addEventListener("click", () => {
  setTerminalPanelVisible(el("terminal-panel").hidden === true);
});
el("new-terminal-tab").addEventListener("click", () => {
  setTerminalPanelVisible(true);
  openNewTerminalTab();
});
el("new-file").addEventListener("click", () => {
  void createFile();
});

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key !== "`" || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.shiftKey) {
    setTerminalPanelVisible(true);
    openNewTerminalTab();
  } else {
    setTerminalPanelVisible(el("terminal-panel").hidden === true);
  }
});

// The terminal starts open with one tab, matching a normal dev environment.
setTerminalPanelVisible(true);

void loadTree({ force: true });
window.setInterval(() => {
  void loadTree();
}, 2000);
