// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { DEFAULT_WORKSPACE_PORT, WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS } from "@edd/config";
import { decideWorkspaceAccessBySubject, type WorkspaceId } from "@edd/core";
import { getToken } from "next-auth/jwt";

import { getControlPlane } from "./control-plane";

/**
 * In-app, path-based workspace editor proxy (`/w/<id>/…`). The single Next.js
 * app authorizes the browser request against its OWN Auth.js session (same-origin
 * cookie — no Pomerium, no cross-subdomain dance), checks per-workspace ownership
 * against DynamoDB IN PROCESS (no PDP round-trip, no gateway token), wakes the
 * workspace on connect, and proxies HTTP + WebSocket to its OpenVSCode upstream
 * (which serves under the same `--server-base-path /w/<id>/`, so paths pass through
 * unrewritten). This collapses Pomerium + the standalone workspace-gate into the
 * app the control plane already runs.
 */

/** The outcome of authorizing a workspace-proxy request. */
export type WorkspaceAuthz =
  | { readonly kind: "allow" }
  | { readonly kind: "unauthenticated" } // no/invalid session → redirect to login
  | { readonly kind: "forbidden" }; // authenticated, not owner/admin, or unknown ws

/** The only slice of an incoming request the authorizer reads — the session cookie.
 * A Node {@link IncomingMessage} structurally satisfies this; narrowing the input to
 * exactly what's used keeps the rest of the request out of the security decision. */
export interface CookieBearingRequest {
  readonly headers: { readonly cookie?: string };
}

/**
 * Authorize a `/w/<id>/…` request: decode the Auth.js session (same-origin cookie),
 * load the workspace, and allow only an admin or the owner (subject match — one IdP,
 * so the session `uid` equals the workspace `ownerId`). Pure I/O at the edges; the
 * decision itself is the pure `decideWorkspaceAccessBySubject`.
 */
export async function authorizeWorkspace(
  req: CookieBearingRequest,
  wsId: WorkspaceId,
): Promise<WorkspaceAuthz> {
  // getToken reads the Auth.js session cookie; pass just that header (a Node
  // IncomingMessage isn't a web Request, but getToken accepts `{ headers }`).
  const token = await getToken({
    req: { headers: { cookie: req.headers.cookie ?? "" } },
    secret: process.env.AUTH_SECRET ?? "",
    secureCookie: (process.env.AUTH_URL ?? "").startsWith("https://"),
  });
  if (token === null) return { kind: "unauthenticated" };

  const detail = await (await getControlPlane()).inspect(wsId);
  if (detail === null) return { kind: "forbidden" }; // unknown ws — don't distinguish

  const granted = decideWorkspaceAccessBySubject({
    callerSubject: typeof token.uid === "string" ? token.uid : undefined,
    callerIsAdmin: token.role === "admin",
    ownerId: detail.workspace.ownerId,
  });
  return granted ? { kind: "allow" } : { kind: "forbidden" };
}

/**
 * Wake the workspace (idempotent) and resolve its live OpenVSCode upstream URL.
 * Throws (caller fails closed → 502) if the wake fails or no host is bound yet.
 */
export async function resolveWorkspaceUpstream(wsId: WorkspaceId): Promise<URL> {
  const cp = await getControlPlane();
  const woken = await cp.connect(wsId);
  if (!woken.ok) throw new Error(`wake failed: ${woken.error.kind}`);
  const host = (await cp.inspect(wsId))?.workspace.sshHost;
  if (host === undefined || host.length === 0) {
    throw new Error("workspace host not yet assigned");
  }
  return new URL(`http://${host}:${String(DEFAULT_WORKSPACE_PORT)}`);
}

/** http.request options forwarding `req` to the workspace `upstream` verbatim (only
 * the Host header is rewritten). The path is preserved — the editor serves under the
 * same `/w/<id>/` base path, so no URL rewriting is needed. */
function upstreamOptions(upstream: URL, req: IncomingMessage): RequestOptions {
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: upstream.host },
  };
}

/** Forward an authorized ordinary HTTP request to the upstream, streaming both ways. */
export function proxyWorkspaceHttp(upstream: URL, req: IncomingMessage, res: ServerResponse): void {
  const proxyReq = httpRequest(upstreamOptions(upstream, req), (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  proxyReq.setTimeout(WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error("upstream timeout"));
  });
  res.on("close", () => {
    proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

/** Forward an authorized WebSocket upgrade and tunnel the two sockets together. */
export function proxyWorkspaceUpgrade(
  upstream: URL,
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const proxyReq = httpRequest(upstreamOptions(upstream, req));
  // Tear down the upstream request if the client disconnects before the upstream
  // upgrades (no leaked socket); once upgraded, the per-socket teardown takes over.
  clientSocket.once("close", () => {
    proxyReq.destroy();
  });
  proxyReq.setTimeout(WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error("upstream timeout"));
  });
  proxyReq.on("upgrade", (proxyRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${String(proxyRes.statusCode ?? 101)} ${proxyRes.statusMessage ?? "Switching Protocols"}`;
    const headerLines = Object.entries(proxyRes.headers).map(
      ([k, val]) => `${k}: ${Array.isArray(val) ? val.join(", ") : (val ?? "")}`,
    );
    clientSocket.write([statusLine, ...headerLines, "", ""].join("\r\n"));
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    const teardown = (): void => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on("error", teardown);
    upstreamSocket.on("close", teardown);
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
  });
  // The upstream answered WITHOUT upgrading (editor not serving WS yet) — relay the
  // status and close, so the client socket doesn't hang open.
  proxyReq.on("response", (proxyRes) => {
    clientSocket.write(
      `HTTP/1.1 ${String(proxyRes.statusCode ?? 502)} ${proxyRes.statusMessage ?? ""}\r\nconnection: close\r\n\r\n`,
    );
    clientSocket.destroy();
    proxyRes.destroy();
  });
  proxyReq.on("error", () => clientSocket.destroy());
  if (head.length > 0) proxyReq.write(head);
  proxyReq.end();
}
