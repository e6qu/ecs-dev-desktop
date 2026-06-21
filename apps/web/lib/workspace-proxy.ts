// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { DEFAULT_WORKSPACE_PORT, WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS } from "@edd/config";
import { decideWorkspaceAccessBySubject, deriveWorkspaceToken, type WorkspaceId } from "@edd/core";
import { getToken } from "next-auth/jwt";

import { CONNECTION_SECRET_ENV } from "./constants";
import { getControlPlane } from "./control-plane";

/** The OpenVSCode query param that carries the connection token, and the cookie it
 * sets once validated — so the proxy injects the token exactly once per session. */
const EDITOR_TOKEN_PARAM = "tkn";
const EDITOR_TOKEN_COOKIE = "vscode-tkn";

/**
 * Defence-in-depth: when the editor runs with a connection token, hand the
 * **already session-authorized** browser its token by redirecting the initial
 * navigation to `…?tkn=<token>`. Returns the redirect target, or `undefined` to
 * forward the request unchanged. Only fires for a top-level document GET that does
 * not already carry the token (query or cookie), and only when a connection secret is
 * configured (otherwise the editor is tokenless/dev and nothing needs injecting). The
 * token is the same per-workspace HMAC the compute provider injected as
 * `CONNECTION_TOKEN`, so no shared state is needed — both sides derive it.
 */
export function editorTokenRedirect(
  req: {
    readonly method?: string;
    readonly url?: string;
    readonly headers: IncomingMessage["headers"];
  },
  wsId: WorkspaceId,
): string | undefined {
  const secret = process.env[CONNECTION_SECRET_ENV] ?? "";
  if (secret.length === 0) return undefined; // tokenless / dev — nothing to inject
  if ((req.method ?? "GET").toUpperCase() !== "GET") return undefined;
  if (req.url === undefined) return undefined;

  // Only redirect a top-level browser navigation (the workbench document), never the
  // editor's own sub-resource/API/WS requests — they ride the cookie once set.
  const dest = headerValue(req.headers["sec-fetch-dest"]);
  const accept = headerValue(req.headers.accept) ?? "";
  const isDocumentNav = dest === "document" || (dest === undefined && accept.includes("text/html"));
  if (!isDocumentNav) return undefined;

  const url = new URL(req.url, "http://internal");
  if (url.searchParams.has(EDITOR_TOKEN_PARAM)) return undefined; // already has the token
  if (cookiePresent(req.headers.cookie, EDITOR_TOKEN_COOKIE)) return undefined; // session established

  url.searchParams.set(EDITOR_TOKEN_PARAM, deriveWorkspaceToken(secret, wsId));
  // Return a path-absolute URL (the dummy origin is dropped) the browser resolves
  // against the real host.
  return `${url.pathname}${url.search}`;
}

/** First value of a possibly-array header. */
function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Auth.js session-cookie name stems (plain + `__Secure-`/`__Host-` prefixes, and the
 * chunked `.0`/`.1` suffixes Auth.js uses for large JWE sessions). */
const SESSION_COOKIE_STEM = "authjs.session-token";

/** Whether a single `name=value` cookie pair carries the Auth.js session token. */
function isSessionCookie(name: string): boolean {
  // Matches `authjs.session-token`, `__Secure-authjs.session-token`, and any `.<n>` chunk.
  return (
    name === SESSION_COOKIE_STEM ||
    name.endsWith(SESSION_COOKIE_STEM) ||
    name.includes(`${SESSION_COOKIE_STEM}.`)
  );
}

/** Strip the platform Auth.js session cookie from a `Cookie` header before forwarding to
 * a workspace container. The container runs user-supplied code/extensions and has no need
 * for the portal session JWT — forwarding it would expose a credential that authorizes
 * the control-plane/admin API to anything that can read the editor's localhost requests
 * (defence-in-depth: the session never crosses into the workspace). Other cookies
 * (notably `vscode-tkn`) pass through. */
export function stripSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const kept = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .filter((p) => {
      const eq = p.indexOf("=");
      const name = eq === -1 ? p : p.slice(0, eq).trim();
      return !isSessionCookie(name);
    });
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** Whether a `Cookie` header contains a cookie named `name` with a non-empty value. */
function cookiePresent(cookieHeader: string | undefined, name: string): boolean {
  if (cookieHeader === undefined) return false;
  return cookieHeader.split(";").some((part) => {
    const eq = part.indexOf("=");
    if (eq === -1) return false;
    return part.slice(0, eq).trim() === name && part.slice(eq + 1).trim().length > 0;
  });
}

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
  // `secureCookie` selects which cookie name + JWE salt getToken reads
  // (`__Secure-authjs.session-token` vs `authjs.session-token`). Inferring it from the
  // AUTH_URL scheme breaks behind a TLS-terminating load balancer when AUTH_URL is unset
  // (Auth.js writes the secure cookie but getToken would look for the plain one → null →
  // a login-redirect loop for already-authenticated users). Instead, detect it from the
  // cookie the browser actually sent, so the read matches whatever Auth.js wrote.
  const cookieHeader = req.headers.cookie ?? "";
  const token = await getToken({
    req: { headers: { cookie: cookieHeader } },
    secret: process.env.AUTH_SECRET ?? "",
    secureCookie: cookieHeader.includes(`__Secure-${SESSION_COOKIE_STEM}`),
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
  const headers = { ...req.headers, host: upstream.host };
  // Never forward the portal Auth.js session cookie into the workspace container.
  const cookie = stripSessionCookie(headerValue(req.headers.cookie));
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers,
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
    // The timeout above bounds only the connect/handshake window. Once upgraded, the
    // tunnel is long-lived and mostly idle (editor heartbeats are seconds-to-minutes
    // apart), so leaving the connect-timeout armed would `destroy()` a healthy live
    // editor session at the first quiet stretch. Clear it; the per-socket teardown
    // below now owns the upgraded sockets' lifecycle.
    proxyReq.setTimeout(0);
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
