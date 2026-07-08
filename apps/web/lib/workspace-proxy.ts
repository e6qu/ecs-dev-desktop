// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { DEFAULT_WORKSPACE_PORT, WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS } from "@edd/config";
import {
  decideWorkspaceAccessBySubject,
  deriveWorkspaceToken,
  type EditorKind,
  type WorkspaceId,
} from "@edd/core";
import { getToken } from "next-auth/jwt";

import { validateAuthSessionToken } from "./auth-sessions";
import { CONNECTION_SECRET_ENV } from "./constants";
import { getControlPlane } from "./control-plane";
import { log } from "./logger";

/** The OpenVSCode query param that carries the connection token, and the cookie it
 * sets once validated — so the proxy injects the token exactly once per session. */
const EDITOR_TOKEN_PARAM = "tkn";
const EDITOR_TOKEN_COOKIE = "vscode-tkn";
// The first-party Monaco editor server (services/editor-monaco) sets a
// DIFFERENTLY-named token cookie than code-server's `vscode-tkn`. The proxy must
// recognize it as "session
// established" too — otherwise it keeps re-injecting `?tkn` on every document
// nav and then forwards a clean request the Monaco server rejects with 401.
// (Kept in sync with @edd/editor-monaco's TOKEN_COOKIE.)
const MONACO_TOKEN_COOKIE = "edd-editor-token";

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
  editor: EditorKind = "openvscode",
): string | undefined {
  const secret = process.env[CONNECTION_SECRET_ENV] ?? "";
  if (secret.length === 0) return undefined; // tokenless / dev — nothing to inject
  if ((req.method ?? "GET").toUpperCase() !== "GET") return undefined;
  if (req.url === undefined) return undefined;

  // `new URL` throws on some crafted targets (e.g. "http://", "//"). This runs in the proxy hot
  // path and must return-or-undefined, never throw — so fail safe on an un-parseable target.
  let url: URL;
  try {
    url = new URL(req.url, "http://internal");
  } catch {
    return undefined;
  }
  // Only redirect a top-level browser navigation (the workbench document), never the
  // editor's own sub-resource/API/WS requests — they ride the cookie once set. Some
  // browser-triggered same-origin navigations can arrive without Sec-Fetch-Dest and
  // without a useful Accept header; the editor root itself is still a document open.
  const dest = headerValue(req.headers["sec-fetch-dest"]);
  const accept = headerValue(req.headers.accept) ?? "";
  const isDocumentNav =
    dest === "document" ||
    (dest === undefined && accept.includes("text/html")) ||
    isWorkspaceRootPath(url.pathname, wsId);
  if (!isDocumentNav) return undefined;
  const expectedToken = deriveWorkspaceToken(secret, wsId);
  if (url.searchParams.get(EDITOR_TOKEN_PARAM) === expectedToken) return undefined;
  if (tokenCookieMatches(req.headers.cookie, tokenCookieForEditor(editor), expectedToken)) {
    return undefined;
  }

  url.searchParams.set(EDITOR_TOKEN_PARAM, expectedToken);
  // Return a path-absolute URL (the dummy origin is dropped) the browser resolves
  // against the real host.
  return `${url.pathname}${url.search}`;
}

function isWorkspaceRootPath(pathname: string, wsId: WorkspaceId): boolean {
  return pathname === `/w/${wsId}` || pathname === `/w/${wsId}/`;
}

function tokenCookieForEditor(editor: EditorKind): string {
  switch (editor) {
    case "openvscode":
    case "claude":
    case "codex":
      return EDITOR_TOKEN_COOKIE;
    case "monaco":
      return MONACO_TOKEN_COOKIE;
  }
}

/** First value of a possibly-array header. */
function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Presence cap for a session token missing `exp` (should not happen — Auth.js
 * always sets it): 30 min, the session's rolling-refresh window. */
const FALLBACK_PRESENCE_GRANT_MS = 30 * 60 * 1000;

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
      if (p.length === 0) return false; // drop empty pairs (empty header / trailing "; ")
      const eq = p.indexOf("=");
      const name = eq === -1 ? p : p.slice(0, eq).trim();
      return !isSessionCookie(name);
    });
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** Whether the first applicable cookie named `name` carries the current workspace token. */
function tokenCookieMatches(
  cookieHeader: string | undefined,
  name: string,
  expectedValue: string,
): boolean {
  if (cookieHeader === undefined) return false;
  return cookieHeader.split(";").some((part) => {
    const eq = part.indexOf("=");
    if (eq === -1) return false;
    if (part.slice(0, eq).trim() !== name) return false;
    return part.slice(eq + 1).trim() === expectedValue;
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

/** The outcome of authorizing a workspace-proxy request. `allow` carries the
 * authorizing session's expiry so the presence registry can cap how long a held
 * connection counts as "user present" (a background tab never rolls its session,
 * so tab-parked workspaces live at most one session length). */
export type WorkspaceAuthz =
  | {
      readonly kind: "allow";
      readonly sessionExpiresAtMs: number;
      readonly subject: string;
      readonly editor: EditorKind;
      // Whether the workspace is actually usable RIGHT NOW (running + the agent
      // reports the editor healthy). When false, a browser document nav to `/w/<id>/`
      // is handed to EDD's status page instead of a not-yet-there editor.
      readonly ready: boolean;
      readonly state: string;
    }
  // authenticated but denied — `subject` (when known) is the caller for the audit trail
  | { readonly kind: "unauthenticated" } // no/invalid session → redirect to login
  | { readonly kind: "forbidden"; readonly subject?: string; readonly reason: string };

/** True when a request is a top-level browser navigation (the workbench document),
 * not the editor's own sub-resource/API/WebSocket traffic. Used to decide when to
 * hand a `/w/<id>/` request to the status page vs. proxy it to the editor. */
export function isDocumentNavigation(req: {
  readonly headers: IncomingMessage["headers"];
}): boolean {
  const dest = headerValue(req.headers["sec-fetch-dest"]);
  const accept = headerValue(req.headers.accept) ?? "";
  return dest === "document" || (dest === undefined && accept.includes("text/html"));
}

/** True for browser document navigations to a workspace, including sparse-header
 * direct opens of `/w/<id>/` that should show the status page while stopped. */
export function isWorkspaceDocumentNavigation(
  req: { readonly url?: string; readonly headers: IncomingMessage["headers"] },
  wsId: WorkspaceId,
): boolean {
  if (isDocumentNavigation(req)) return true;
  if (req.url === undefined) return false;
  try {
    return isWorkspaceRootPath(new URL(req.url, "http://internal").pathname, wsId);
  } catch {
    return false;
  }
}

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
  // Fail loud on a missing secret rather than reading tokens with `?? ""` — an empty secret would
  // silently reject every session (→ login-redirect loop) instead of surfacing the misconfig.
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret === undefined || authSecret === "") {
    throw new Error("AUTH_SECRET is required to authorize workspace-proxy requests");
  }
  const token = await getToken({
    req: { headers: { cookie: cookieHeader } },
    secret: authSecret,
    secureCookie: cookieHeader.includes(`__Secure-${SESSION_COOKIE_STEM}`),
  });
  if (token === null) return { kind: "unauthenticated" };
  const authSession = await validateAuthSessionToken(token);
  if (authSession === null) return { kind: "unauthenticated" };

  const callerSubject = typeof token.uid === "string" ? token.uid : undefined;
  const detail = await (await getControlPlane()).inspect(wsId);
  if (detail === null) {
    // Unknown ws — don't distinguish unknown-vs-unowned to the caller, but DO record
    // it so a "forbidden" on a workspace that actually exists is diagnosable.
    log.warn("workspace-proxy denied: workspace not found", { wsId, callerSubject });
    return { kind: "forbidden", subject: callerSubject, reason: "workspace not found" };
  }

  const callerIsAdmin = token.role === "admin";
  const granted = decideWorkspaceAccessBySubject({
    callerSubject,
    callerIsAdmin,
    ownerId: detail.workspace.ownerId,
  });
  if (!granted) {
    // The recurring "Forbidden on my own/again" reports had no server-side trace.
    // Record exactly why the decision failed (never the token itself): who the
    // caller is, their role, and who owns it — so owner-mismatch (a stale/rewritten
    // uid) is instantly distinguishable from a non-admin opening someone else's.
    const reason = `not owner and not admin (role=${
      typeof token.role === "string" ? token.role : "(none)"
    }, owner=${detail.workspace.ownerId})`;
    log.warn("workspace-proxy denied: not owner and not admin", {
      wsId,
      callerSubject: callerSubject ?? "(no uid on token)",
      callerRole: typeof token.role === "string" ? token.role : "(no role)",
      ownerId: detail.workspace.ownerId,
    });
    return { kind: "forbidden", subject: callerSubject, reason };
  }
  // The JWT's exp (NumericDate, seconds) is when this session stops vouching for a
  // held connection. Auth.js always sets it; if a token somehow lacks one, cap the
  // grant conservatively at the rolling-refresh window rather than forever.
  const sessionExpiresAtMs =
    typeof token.exp === "number"
      ? Math.min(token.exp * 1000, authSession.expiresAtMs)
      : Math.min(Date.now() + FALLBACK_PRESENCE_GRANT_MS, authSession.expiresAtMs);
  const ready = detail.workspace.state === "running" && detail.workspace.functional === "ok";
  return {
    kind: "allow",
    sessionExpiresAtMs,
    subject: callerSubject ?? "(no uid)",
    editor: detail.workspace.editor ?? "openvscode",
    ready,
    state: detail.workspace.state,
  };
}

/** The two spectate WebSocket roles (docs/design-public-spectate.md). */
export type SpectateRole = "publish" | "subscribe";

export type SpectateAuthz =
  | { kind: "allow"; role: SpectateRole }
  | { kind: "forbidden" }
  | { kind: "unauthenticated" };

/**
 * Authorize a spectate WebSocket. `publish` is the OWNER's mirror stream (only
 * the owner may publish — an admin must not impersonate a share). `subscribe`
 * is any signed-in principal with a role (viewer+ — the recorded product
 * decision: authenticated org users, no anonymous links). Both require the
 * owner's share flag to be ON; toggling it off severs new connections
 * immediately (live ones die with the publisher).
 */
export async function authorizeSpectate(
  req: CookieBearingRequest,
  wsId: WorkspaceId,
  role: SpectateRole,
): Promise<SpectateAuthz> {
  const cookieHeader = req.headers.cookie ?? "";
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret === undefined || authSecret === "") {
    throw new Error("AUTH_SECRET is required to authorize spectate requests");
  }
  const token = await getToken({
    req: { headers: { cookie: cookieHeader } },
    secret: authSecret,
    secureCookie: cookieHeader.includes(`__Secure-${SESSION_COOKIE_STEM}`),
  });
  if (token === null) return { kind: "unauthenticated" };
  if ((await validateAuthSessionToken(token)) === null) return { kind: "unauthenticated" };

  const detail = await (await getControlPlane()).inspect(wsId);
  if (detail === null) return { kind: "forbidden" };
  if (detail.workspace.shareEnabled !== true) return { kind: "forbidden" };

  if (role === "publish") {
    const isOwner = typeof token.uid === "string" && token.uid === detail.workspace.ownerId;
    return isOwner ? { kind: "allow", role } : { kind: "forbidden" };
  }
  // subscribe: any signed-in principal with a mapped role (viewer is the floor).
  return typeof token.role === "string" && token.role.length > 0
    ? { kind: "allow", role }
    : { kind: "forbidden" };
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
