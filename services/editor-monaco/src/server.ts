// SPDX-License-Identifier: AGPL-3.0-or-later
// The Monaco editor server: serves the SPA + a confined file API under the workspace base path,
// behind the same connection-token gate OpenVSCode uses. Listens on :3000 so the in-app proxy
// (`/w/<id>/…`) forwards to it unchanged — Monaco becomes a drop-in editor for the workspace.
import { promises as fs } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import * as path from "node:path";

import { buildTree, readTextFile, writeTextFile } from "./file-api";
import { attachTerminal, type PtySpawner } from "./terminal";
import { tokenCookie, tokenFromRequest, tokensMatch } from "./token";

export interface EditorServerOptions {
  /** The workspace filesystem root that is served + edited (e.g. /home/workspace). */
  readonly root: string;
  /** The path the proxy serves this editor under, e.g. "/w/<id>/" (must end in "/"). */
  readonly basePath: string;
  /** Built SPA assets directory (index.html + assets/…). */
  readonly spaDir: string;
  /** Expected connection token; undefined disables auth (dev/standalone only). */
  readonly token?: string;
  /** Program each terminal boots into instead of a plain shell (agent-first
   * modes; see TerminalDeps.command). */
  readonly terminalCommand?: string;
  /** Hide the Monaco/file explorer surface and present the terminal as the workspace. */
  readonly terminalOnly?: boolean;
  /** Override the PTY backend (tests inject a fake shell). Defaults to real node-pty. */
  readonly spawnPty?: PtySpawner;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Structured stdout line (→ CloudWatch /edd-prod/workspaces) for editor-gate debugging. */
function logLine(msg: string, fields: Record<string, string | boolean>): void {
  process.stdout.write(`${JSON.stringify({ svc: "editor-monaco", msg, ...fields })}\n`);
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), MIME[".json"]);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(res: ServerResponse, spaDir: string, rel: string): Promise<void> {
  // Confine the asset path to spaDir; unknown paths fall back to the SPA shell (client routing).
  const target = path.resolve(spaDir, rel);
  const safe =
    target === path.resolve(spaDir) || target.startsWith(path.resolve(spaDir) + path.sep);
  const file = safe && rel !== "" ? target : path.join(spaDir, "index.html");
  try {
    const body = await fs.readFile(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    send(res, 404, "not found");
  }
}

/** Build the editor HTTP server (no listen — the caller binds the port). */
export function createEditorServer(opts: EditorServerOptions): Server {
  const base = opts.basePath.endsWith("/") ? opts.basePath : `${opts.basePath}/`;

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "internal error");
    });
  });
  // The interactive terminal rides a WebSocket on the same server + token gate.
  attachTerminal(server, {
    root: opts.root,
    basePath: base,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    ...(opts.terminalCommand === undefined ? {} : { command: opts.terminalCommand }),
    ...(opts.spawnPty === undefined ? {} : { spawnPty: opts.spawnPty }),
  });
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(base)) {
      send(res, 404, "not found");
      return;
    }

    // Connection-token gate (mirrors OpenVSCode): validate, set a cookie, redirect to a clean URL.
    if (opts.token !== undefined) {
      const fromQuery = url.searchParams.has("tkn");
      const fromCookie = /(?:^|;\s*)edd-editor-token=/.test(req.headers.cookie ?? "");
      const presented = tokenFromRequest(url.searchParams, req.headers.cookie);
      if (presented === undefined || !tokensMatch(opts.token, presented)) {
        // Structured 401 diagnostics (stdout → CloudWatch). Never the token itself:
        // only a short prefix so a mismatch (wrong secret) is distinguishable from a
        // missing token (no ?tkn and no cookie — the cookie never got set/sent).
        logLine("token-gate 401", {
          path: url.pathname,
          dest: req.headers["sec-fetch-dest"] ?? "",
          presentedFrom: fromQuery ? "query" : fromCookie ? "cookie" : "none",
          expectedPrefix: opts.token.slice(0, 6),
          presentedPrefix: presented === undefined ? "(none)" : presented.slice(0, 6),
          hasCookieHeader: req.headers.cookie !== undefined,
        });
        send(res, 401, "unauthorized");
        return;
      }
      if (fromQuery) {
        logLine("token-gate ok: setting cookie + redirecting clean", { path: url.pathname });
        res.statusCode = 302;
        res.setHeader("Set-Cookie", tokenCookie(opts.token, base));
        res.setHeader("Location", url.pathname);
        res.end();
        return;
      }
    }

    const sub = url.pathname.slice(base.length);

    if (sub === "api/tree" && req.method === "GET") {
      sendJson(res, 200, { entries: await buildTree(opts.root) });
      return;
    }
    if (sub === "api/config" && req.method === "GET") {
      sendJson(res, 200, { terminalOnly: opts.terminalOnly === true });
      return;
    }
    if (sub === "api/file") {
      const rel = url.searchParams.get("path");
      if (rel === null || rel === "") {
        send(res, 400, "path required");
        return;
      }
      try {
        if (req.method === "GET") {
          send(res, 200, await readTextFile(opts.root, rel));
          return;
        }
        if (req.method === "PUT") {
          await writeTextFile(opts.root, rel, await readBody(req));
          sendJson(res, 200, { ok: true });
          return;
        }
      } catch (e) {
        send(res, 400, e instanceof Error ? e.message : "bad request");
        return;
      }
      send(res, 405, "method not allowed");
      return;
    }

    await serveStatic(res, opts.spaDir, sub);
  }
}
