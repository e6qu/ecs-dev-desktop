// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Custom Next.js server. Serves the portal + admin + control-plane API as usual,
 * AND fronts the in-app, path-based workspace editor proxy at `/w/<id>/…`:
 * authorize the browser against the SAME Auth.js session (same-origin cookie),
 * check per-workspace ownership in process, wake the workspace, and proxy HTTP +
 * WebSocket to its OpenVSCode upstream. This is what lets us collapse Pomerium +
 * the standalone workspace-gate into the single app (the WebSocket upgrade can't
 * go through a Next App-Router route handler, hence the custom server).
 */
import { createServer } from "node:http";

import { workspaceIdFromPath } from "@edd/core";
import next from "next";

import {
  authorizeWorkspace,
  proxyWorkspaceHttp,
  proxyWorkspaceUpgrade,
  resolveWorkspaceUpstream,
} from "./lib/workspace-proxy";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? "3700");
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

const app = next({ dev, hostname, port });
await app.prepare();
// Both handlers must be obtained AFTER prepare() — they touch the initialized server.
const handleRequest = app.getRequestHandler();
const handleUpgrade = app.getUpgradeHandler();

const server = createServer((req, res) => {
  const wsId = workspaceIdFromPath(req.url ?? "");
  if (wsId === undefined) {
    void handleRequest(req, res);
    return;
  }
  void (async () => {
    const authz = await authorizeWorkspace(req, wsId);
    if (authz.kind === "unauthenticated") {
      // Send the browser to login, returning to the workspace URL afterward.
      res.writeHead(302, { location: `/login?callbackUrl=${encodeURIComponent(req.url ?? "/")}` });
      res.end();
      return;
    }
    if (authz.kind === "forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    try {
      proxyWorkspaceHttp(await resolveWorkspaceUpstream(wsId), req, res);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "workspace unavailable" }));
    }
  })();
});

server.on("upgrade", (req, socket, head) => {
  const wsId = workspaceIdFromPath(req.url ?? "");
  if (wsId === undefined) {
    // Next's own upgrades (Turbopack HMR in dev) — let Next handle them.
    void handleUpgrade(req, socket, head);
    return;
  }
  void (async () => {
    const authz = await authorizeWorkspace(req, wsId);
    if (authz.kind !== "allow") {
      socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      proxyWorkspaceUpgrade(await resolveWorkspaceUpstream(wsId), req, socket, head);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      socket.destroy();
    }
  })();
});

server.listen(port, hostname);
process.stdout.write(`edd control plane listening on http://${hostname}:${String(port)}\n`);
