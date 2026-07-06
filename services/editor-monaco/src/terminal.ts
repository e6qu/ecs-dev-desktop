// SPDX-License-Identifier: AGPL-3.0-or-later
// A real terminal for the Monaco editor: a PTY (node-pty) bridged to the browser (xterm) over a
// WebSocket at `<base>terminal`, behind the same connection-token gate as the HTTP surface. The
// client speaks a tiny JSON protocol — {type:"input",data} keystrokes and {type:"resize",cols,rows}.
import type { Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { touchActivity } from "./activity";
import { tokenFromRequest, tokensMatch } from "./token";

interface TerminalDeps {
  readonly root: string;
  readonly basePath: string;
  readonly token?: string;
  /** Program each terminal boots into instead of a plain shell — the agent-first
   * editor modes (`claude` / `codex`) set this via EDD_TERMINAL_COMMAND. Runs
   * under a login shell (`$SHELL -lc "exec …"`) so it gets the image's full PATH;
   * when it exits, the PTY (and tab) closes — a new tab starts it fresh. Trusted
   * operator config from the container entrypoint, never user input. */
  readonly command?: string;
}

/** Decode a ws frame (Buffer / ArrayBuffer / Buffer[]) to a UTF-8 string. */
function rawToString(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

/** A finite, positive integer — a valid PTY dimension (rejects NaN/Infinity/floats/<=0). */
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Narrow a client message to the input/resize protocol without unsafe casts. */
export function parseMessage(
  raw: string,
): { input: string } | { cols: number; rows: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  if (value.type === "input" && "data" in value && typeof value.data === "string") {
    return { input: value.data };
  }
  if (
    value.type === "resize" &&
    "cols" in value &&
    "rows" in value &&
    isPositiveInt(value.cols) &&
    isPositiveInt(value.rows)
  ) {
    return { cols: value.cols, rows: value.rows };
  }
  return null;
}

// node-pty is loaded lazily (only when a terminal actually connects) so the editor still serves if
// the native binding is missing/incompatible — the terminal degrades, the editor does not.
async function loadPty(): Promise<typeof import("node-pty") | null> {
  try {
    return await import("node-pty");
  } catch {
    return null;
  }
}

/** One-time orientation banner, sent as the first line of every new terminal tab
 * (ahead of the shell's own output): claude/codex's OAuth login opens a browser
 * redirect to a localhost port inside THIS remote container — unreachable from the
 * user's own browser. Both CLIs already support pasting the code shown in the
 * browser instead of waiting for the redirect; this is pure user education, no new
 * infrastructure. */
const WELCOME_BANNER =
  "\x1b[2mTip: when 'claude' or 'codex' asks you to sign in, the browser redirect can't reach this remote workspace -- paste the code shown in the browser instead of waiting for it.\x1b[0m\r\n";

async function startShell(ws: WebSocket, root: string, command?: string): Promise<void> {
  const nodePty = await loadPty();
  if (nodePty === null) {
    ws.close(1011, "terminal unavailable");
    return;
  }
  if (ws.readyState === ws.OPEN) ws.send(WELCOME_BANNER);
  const shell = process.env.SHELL ?? "/bin/bash";
  // Agent-first modes boot the terminal straight into the configured program via a
  // login shell (full image PATH); `exec` replaces the shell so the program's exit
  // closes the PTY. A plain shell otherwise.
  const args = command === undefined ? [] : ["-lc", `exec ${command}`];
  const pty = nodePty.spawn(shell, args, {
    name: "xterm-color",
    cwd: root,
    env: process.env,
    cols: 80,
    rows: 24,
  });
  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  pty.onExit(() => {
    ws.close();
  });
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const msg = parseMessage(rawToString(raw));
    if (msg === null) return;
    if ("input" in msg) {
      // Keystrokes are the definition of "in use" (see ./activity.ts).
      touchActivity();
      pty.write(msg.input);
    } else {
      pty.resize(msg.cols, msg.rows);
    }
  });
  ws.on("close", () => {
    pty.kill();
  });
}

/** Attach the terminal WebSocket endpoint to an existing HTTP server. */
export function attachTerminal(server: Server, deps: TerminalDeps): void {
  const base = deps.basePath.endsWith("/") ? deps.basePath : `${deps.basePath}/`;
  const termPath = `${base}terminal`;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== termPath) {
      socket.destroy();
      return;
    }
    if (deps.token !== undefined) {
      const presented = tokenFromRequest(url.searchParams, req.headers.cookie);
      if (presented === undefined || !tokensMatch(deps.token, presented)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void startShell(ws, deps.root, deps.command);
    });
  });
}
