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

import { workspaceId, workspaceIdFromPath, type WorkspaceId } from "@edd/core";
import next from "next";
import { WebSocketServer } from "ws";

import { NO_PUBLISHER_CODE, spectateRelay } from "./lib/spectate-relay";
import { PRESENCE_SWEEP_MS, sweepPresence, workspacePresence } from "./lib/workspace-presence";
import {
  authorizeSpectate,
  authorizeWorkspace,
  editorTokenRedirect,
  proxyWorkspaceHttp,
  proxyWorkspaceUpgrade,
  resolveWorkspaceUpstream,
  type SpectateRole,
} from "./lib/workspace-proxy";

/** Parse `/api/spectate/<workspace-id>/(publish|subscribe)` upgrade paths. */
function spectatePathParts(url: string): { wsId: WorkspaceId; role: SpectateRole } | undefined {
  const m = /^\/api\/spectate\/([\w-]+)\/(publish|subscribe)$/.exec(url.split("?")[0] ?? "");
  if (m?.[1] === undefined) return undefined;
  // The alternation in the pattern guarantees group 2 is exactly one of the roles.
  return { wsId: workspaceId(m[1]), role: m[2] as SpectateRole };
}

/** Spectate WebSocket endpoint (noServer: upgrades are routed manually below). */
const spectateWss = new WebSocketServer({ noServer: true });

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? "3700");
// Bind ALL interfaces (0.0.0.0), NOT process.env.HOSTNAME. ECS/Docker injects the
// container's own hostname into HOSTNAME, so reading it here bound the server to a
// single interface (the task ENI) — the ALB (hitting the ENI IP) still worked, but
// the container health check hits `localhost:3000`, which the server was no longer
// listening on, so ECS marked tasks UNHEALTHY and SIGTERM-killed them mid-rollout
// (exit 143) → deployment circuit-breaker → failed deploys. 0.0.0.0 covers both the
// ENI IP (ALB) and loopback (health check). Override only via an explicit, non-ECS
// env for local edge cases.
const bindHost = process.env.EDD_BIND_HOST ?? "0.0.0.0";

const app = next({ dev, hostname: bindHost, port });
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
    // Defence-in-depth: hand the authorized browser the editor's connection token on
    // the initial navigation, so the workbench loads without the user ever seeing it.
    const tokenRedirect = editorTokenRedirect(req, wsId);
    if (tokenRedirect !== undefined) {
      // `no-referrer` so the `?tkn=<connection-token>` the browser lands on is never
      // leaked in a Referer header to any sub-resource or outbound link.
      res.writeHead(302, { location: tokenRedirect, "referrer-policy": "no-referrer" });
      res.end();
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
  const spectate = spectatePathParts(req.url ?? "");
  if (spectate !== undefined) {
    void (async () => {
      const authz = await authorizeSpectate(req, spectate.wsId, spectate.role);
      if (authz.kind !== "allow") {
        socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      spectateWss.handleUpgrade(req, socket, head, (client) => {
        if (spectate.role === "publish") {
          const unpublish = spectateRelay.publish(spectate.wsId, client);
          client.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
            const buf = Array.isArray(data)
              ? Buffer.concat(data)
              : data instanceof ArrayBuffer
                ? Buffer.from(data)
                : data;
            spectateRelay.forward(spectate.wsId, buf.toString("utf8"));
          });
          client.once("close", unpublish);
        } else {
          const unsubscribe = spectateRelay.subscribe(spectate.wsId, client);
          if (unsubscribe === null) {
            // No publisher on THIS replica: tell the client to retry — a new TCP
            // connection may land on the replica holding the owner's stream (v1
            // per-replica relay; the internal cross-replica bridge is a follow-up).
            client.close(NO_PUBLISHER_CODE, "no publisher on this replica");
            return;
          }
          client.once("close", unsubscribe);
          // Spectators deliberately count toward NOTHING (not presence/idle):
          // a viewer must never keep a workspace running or billing.
        }
      });
    })();
    return;
  }
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
    // Presence: this live editor socket means a user has the workspace LOADED (a
    // background tab counts) — tracked until the socket closes or the authorizing
    // session expires, whichever is first. The periodic sweep below turns tracked
    // presence into activity heartbeats so the reconciler keeps the workspace up.
    const untrack = workspacePresence.track(wsId, authz.sessionExpiresAtMs);
    socket.once("close", untrack);
    try {
      proxyWorkspaceUpgrade(await resolveWorkspaceUpstream(wsId), req, socket, head);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      socket.destroy();
    }
  })();
});

// Presence sweep: refresh lastActivity for every workspace with a live editor
// socket on THIS replica (each replica sweeps its own connections). unref() so
// the timer never holds the process open on shutdown.
setInterval(() => {
  void sweepPresence();
}, PRESENCE_SWEEP_MS).unref();

server.listen(port, bindHost);
process.stdout.write(`edd control plane listening on http://${bindHost}:${String(port)}\n`);
