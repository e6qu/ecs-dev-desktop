// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Owner-side spectate capture (docs/design-public-spectate.md): while the
 * owner has sharing enabled, mirror this editor tab's rendered view state —
 * open file + content, cursor/selection, mouse position, terminal output,
 * focus — to the control plane's relay, where signed-in viewers subscribe.
 *
 * Spectators never connect to the workspace; this module is the only source of
 * what they see. Terminal mirroring starts when capture starts (no scrollback
 * backfill — recorded product decision).
 *
 * The SPA can't be told the share flag at build time, so it polls the
 * same-origin workspace API (owner session cookie) and starts/stops the
 * publish socket as the owner toggles sharing.
 */
import type * as monacoNs from "monaco-editor";

const SHARE_POLL_MS = 15_000;
const FILE_DEBOUNCE_MS = 500;
const CURSOR_THROTTLE_MS = 100;
const MOUSE_THROTTLE_MS = 50;
/** Reconnect delay after a dropped publish socket while sharing stays on. */
const RECONNECT_MS = 3_000;

interface CaptureDeps {
  editor: monacoNs.editor.IStandaloneCodeEditor;
  getCurrentPath: () => string | null;
}

let sock: WebSocket | null = null;
let deps: CaptureDeps | null = null;
let sharing = false;

function send(frame: Record<string, unknown>): void {
  if (sock !== null && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(frame));
}

/** The workspace id from the proxied path (`/w/<id>/…`). */
function workspaceIdFromLocation(): string | null {
  const m = /^\/w\/([\w-]+)\//.exec(window.location.pathname);
  return m?.[1] ?? null;
}

function sendFileSnapshot(): void {
  if (deps === null) return;
  send({ t: "file", path: deps.getCurrentPath(), content: deps.editor.getValue() });
}

function sendCursor(): void {
  if (deps === null) return;
  const pos = deps.editor.getPosition();
  const sel = deps.editor.getSelection();
  send({
    t: "cursor",
    line: pos?.lineNumber ?? 1,
    col: pos?.column ?? 1,
    sel:
      sel === null
        ? null
        : {
            sl: sel.startLineNumber,
            sc: sel.startColumn,
            el: sel.endLineNumber,
            ec: sel.endColumn,
          },
  });
}

function sendFocus(): void {
  send({ t: "focus", focused: document.hasFocus(), visible: !document.hidden });
}

function throttle<A extends unknown[]>(ms: number, fn: (...args: A) => void): (...args: A) => void {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

function debounce(ms: number, fn: () => void): () => void {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}

const onMouse = throttle(MOUSE_THROTTLE_MS, (e: MouseEvent) => {
  send({
    t: "mouse",
    x: e.clientX / window.innerWidth,
    y: e.clientY / window.innerHeight,
  });
});
const onCursorThrottled = throttle(CURSOR_THROTTLE_MS, sendCursor);
const onFileDebounced = debounce(FILE_DEBOUNCE_MS, sendFileSnapshot);

/** Terminal output chunks (called from main.ts's terminal message handler).
 * Forwarded live-only while a publish socket is open. */
export function captureTermOutput(tabId: number, data: string): void {
  send({ t: "term", tab: tabId, data });
}

/** Terminal tab layout changed (count/active). */
export function captureTabs(count: number, active: number): void {
  send({ t: "tabs", count, active });
}

function openPublishSocket(wsId: string): void {
  const url = new URL(`/api/spectate/${wsId}/publish`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const s = new WebSocket(url);
  sock = s;
  s.addEventListener("open", () => {
    // Prime the stream so a spectator joining now sees the current state.
    sendFileSnapshot();
    sendCursor();
    sendFocus();
  });
  s.addEventListener("close", () => {
    if (sock === s) sock = null;
    // The relay replaces us if a newer tab publishes; otherwise retry while
    // sharing stays enabled (transient drop / control-plane deploy).
    if (sharing)
      window.setTimeout(() => {
        if (sharing && sock === null) openPublishSocket(wsId);
      }, RECONNECT_MS);
  });
}

function startSharing(wsId: string): void {
  if (sharing) return;
  sharing = true;
  openPublishSocket(wsId);
  window.addEventListener("mousemove", onMouse);
  window.addEventListener("focus", sendFocus);
  window.addEventListener("blur", sendFocus);
  document.addEventListener("visibilitychange", sendFocus);
}

function stopSharing(): void {
  if (!sharing) return;
  sharing = false;
  window.removeEventListener("mousemove", onMouse);
  window.removeEventListener("focus", sendFocus);
  window.removeEventListener("blur", sendFocus);
  document.removeEventListener("visibilitychange", sendFocus);
  sock?.close(1000, "sharing disabled");
  sock = null;
}

/**
 * Wire the capture: register editor listeners once, then poll the share flag
 * and publish only while it's on. Call once at SPA startup.
 */
export function initSpectateCapture(d: CaptureDeps): void {
  deps = d;
  d.editor.onDidChangeModelContent(() => {
    onFileDebounced();
  });
  d.editor.onDidChangeCursorPosition(() => {
    onCursorThrottled();
  });
  d.editor.onDidChangeCursorSelection(() => {
    onCursorThrottled();
  });

  const wsId = workspaceIdFromLocation();
  if (wsId === null) return; // not served through the proxy (bare dev) — nothing to mirror

  const poll = async (): Promise<void> => {
    try {
      const res = await fetch(`/api/workspaces/${wsId}`, { credentials: "same-origin" });
      if (!res.ok) return;
      const body: unknown = await res.json();
      const enabled = (body as { shareEnabled?: unknown }).shareEnabled === true;
      if (enabled) startSharing(wsId);
      else stopSharing();
    } catch {
      /* transient — next poll retries */
    }
  };
  void poll();
  window.setInterval(() => {
    void poll();
  }, SHARE_POLL_MS);
}

/** Mark the current file explicitly (open/switch) — bypasses the debounce. */
export function captureFileOpened(): void {
  sendFileSnapshot();
  sendCursor();
}
