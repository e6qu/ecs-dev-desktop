// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import {
  DEFAULT_WORKSPACE_PORT,
  DEFAULT_WORKSPACE_TERMINAL_PORT,
  WORKSPACE_PROXY_MAX_REWRITE_BYTES,
  WORKSPACE_PROXY_UPSTREAM_TIMEOUT_MS,
  WORKSPACE_TERMINAL_OVERLAY_SEGMENT,
} from "@edd/config";
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
import { recordSystemActivity } from "./system-activity";

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
const OPENCODE_USERNAME = "opencode";
const EDD_WORKSPACES_HOME_HREF = "/workspaces";
const EDD_WORKSPACES_HOME_ID = "edd-workspaces-home";

export interface WorkspaceProxyContext {
  readonly wsId: WorkspaceId;
  readonly editor: EditorKind;
}

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
  if (editor === "opencode") return undefined;
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
      return EDITOR_TOKEN_COOKIE;
    case "monaco":
    case "terminal":
      return MONACO_TOKEN_COOKIE;
    case "opencode":
      return EDITOR_TOKEN_COOKIE;
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
  // An authorized editor request is live use of the control plane: stamp CP activity
  // so control-plane scale-to-zero does not tear down the app (and drop this session's
  // editor WebSocket) mid-use. Editor surfaces generate steady proxied traffic (asset
  // fetches, saves, LSP), so this keeps the CP warm for the whole session. Fire-and-forget
  // + throttled internally (≤1 DynamoDB write/min); it never blocks or fails the request.
  void recordSystemActivity();
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
  return resolveWorkspaceUpstreamOnPort(wsId, DEFAULT_WORKSPACE_PORT);
}

/**
 * The opencode terminal-overlay upstream: the first-party terminal server runs as a SIDECAR on
 * {@link DEFAULT_WORKSPACE_TERMINAL_PORT} inside an opencode workspace, serving the terminal UI the
 * overlay's iframe loads at `/w/<id>/__edd_term/`. Same host as the editor, different port.
 */
export async function resolveWorkspaceTerminalUpstream(wsId: WorkspaceId): Promise<URL> {
  return resolveWorkspaceUpstreamOnPort(wsId, DEFAULT_WORKSPACE_TERMINAL_PORT);
}

async function resolveWorkspaceUpstreamOnPort(wsId: WorkspaceId, port: number): Promise<URL> {
  const cp = await getControlPlane();
  const woken = await cp.connect(wsId);
  if (!woken.ok) throw new Error(`wake failed: ${woken.error.kind}`);
  const host = (await cp.inspect(wsId))?.workspace.sshHost;
  if (host === undefined || host.length === 0) {
    throw new Error("workspace host not yet assigned");
  }
  return new URL(`http://${host}:${String(port)}`);
}

/** The `/w/<id>/__edd_term` path prefix the opencode terminal overlay (its iframe + assets + PTY
 * WebSocket) is served under. */
function terminalOverlayPrefix(wsId: WorkspaceId): string {
  return `/w/${wsId}/${WORKSPACE_TERMINAL_OVERLAY_SEGMENT}`;
}

/**
 * True when this request targets the opencode terminal overlay (only opencode workspaces run the
 * sidecar). Such requests are proxied to the terminal port as a PLAIN base-path editor — NOT
 * through opencode's prefix-strip/Basic-auth/shim path. Fail-safe `false` on an un-parseable URL.
 */
export function isTerminalOverlayRequest(
  editor: EditorKind,
  wsId: WorkspaceId,
  reqUrl: string | undefined,
): boolean {
  if (editor !== "opencode" || reqUrl === undefined) return false;
  let pathname: string;
  try {
    pathname = new URL(reqUrl, "http://internal").pathname;
  } catch {
    return false;
  }
  const prefix = terminalOverlayPrefix(wsId);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function workspaceProxyRequestPath(
  editor: EditorKind,
  wsId: WorkspaceId,
  reqUrl: string | undefined,
): string | undefined {
  if (editor !== "opencode" || reqUrl === undefined) return reqUrl;
  const url = new URL(reqUrl, "http://internal");
  const prefix = `/w/${wsId}`;
  if (url.pathname === prefix || url.pathname === `${prefix}/`) {
    url.pathname = "/";
  } else if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  } else {
    throw new Error(`opencode proxy path is outside workspace prefix: ${url.pathname}`);
  }
  return `${url.pathname}${url.search}`;
}

export function opencodeProxyAuthorization(secret: string, wsId: WorkspaceId): string {
  if (secret.length === 0) {
    throw new Error(`${CONNECTION_SECRET_ENV} is required to proxy opencode workspaces`);
  }
  const token = deriveWorkspaceToken(secret, wsId);
  return `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${token}`, "utf8").toString("base64")}`;
}

function opencodeRewriteBase(wsId: WorkspaceId): string {
  return `/w/${wsId}`;
}

function responseCanBeRewritten(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const lower = contentType.toLowerCase();
  // HTML + CSS ONLY. JavaScript is NEVER rewritten: a byte-level regex over a minified
  // bundle inevitably mangles string/regex literals — a `"…"/re/` boundary turns into an
  // invalid regex literal ("Invalid regular expression flags") and the whole module
  // aborts, leaving opencode blank (reproduced live: the blanket rewrite fired 575× in a
  // 2.78 MB opencode bundle and corrupted it). opencode's root-absolute RUNTIME requests
  // are rebased by the injected base-path shim (buildOpencodeBasePathShim), not by editing
  // the bundle text; static `<script src>`/`<link href>` are rewritten as HTML attributes.
  return lower.includes("text/html") || lower.includes("text/css");
}

function responseIsHtml(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes("text/html") === true;
}

/** True for a JavaScript response (`text/javascript` / `application/javascript`). Only opencode
 * buffers JS, and only to apply the one targeted router base-path anchor (patchOpencodeRouterBase). */
function responseIsJavaScript(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes("javascript") === true;
}

/**
 * A fixed home-link pill unavoidably intercepts pointer events over whatever chrome
 * it covers, so it must be anchored to each editor's DEAD zone:
 * - OpenVSCode's menu bar (File/Edit/…) occupies the TOP-LEFT, so a top-left pill
 *   sat on top of the File menu and blocked its click (found live). Anchor it
 *   BOTTOM-left instead, above the status bar, where it only overlaps the low-value
 *   activity-bar corner.
 * - opencode's message input is at the BOTTOM, so it keeps the top-left anchor (its
 *   header there is inert).
 */
function homeLinkPosition(editor: EditorKind): string {
  return editor === "openvscode" ? "bottom:28px;left:12px" : "top:10px;left:10px";
}

export function injectWorkspaceHomeLink(html: string, editor: EditorKind): string {
  if (html.includes(`id="${EDD_WORKSPACES_HOME_ID}"`)) return html;
  const bodyMatch = /<body\b[^>]*>/i.exec(html);
  if (bodyMatch === null) {
    throw new Error("workspace HTML did not contain a <body> tag for EDD workspace navigation");
  }
  const insertAt = bodyMatch.index + bodyMatch[0].length;
  const link = [
    `<a id="${EDD_WORKSPACES_HOME_ID}" href="${EDD_WORKSPACES_HOME_HREF}"`,
    ` style="position:fixed;z-index:2147483647;${homeLinkPosition(editor)};display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(11,15,13,.92);color:#4ec9b0;text-decoration:none;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)"`,
    ' title="Back to EDD workspaces">⌂ EDD home</a>',
  ].join("");
  return `${html.slice(0, insertAt)}${link}${html.slice(insertAt)}`;
}

const EDD_TERM_TOGGLE_ID = "edd-term-toggle";
const EDD_TERM_OVERLAY_ID = "edd-term-overlay";
const EDD_TERM_FRAME_ID = "edd-term-frame";
const EDD_TERM_MIN_ID = "edd-term-min";

/**
 * Give opencode (which ships no terminal) a full multi-tab terminal: inject a persistent
 * bottom-left toggle button plus an on-top overlay whose iframe loads the first-party terminal
 * server running as a sidecar at `/w/<id>/__edd_term/`. The overlay is hidden until first opened
 * (the iframe's `src` is set lazily by the shim, so no PTY connects until the user asks). The
 * toggle/minimize CLICK handling lives in the injected base-path shim (a capture-phase listener,
 * covered by the shim's whitelisted CSP hash) — inline `onclick` is blocked by opencode's CSP.
 */
export function injectOpencodeTerminalOverlay(html: string, wsId: WorkspaceId): string {
  if (html.includes(`id="${EDD_TERM_TOGGLE_ID}"`)) return html;
  const bodyMatch = /<body\b[^>]*>/i.exec(html);
  if (bodyMatch === null) {
    throw new Error("opencode HTML did not contain a <body> tag for the terminal overlay");
  }
  const src = `/w/${wsId}/${WORKSPACE_TERMINAL_OVERLAY_SEGMENT}/`;
  const z = "2147483646"; // just below the home-link pill (2147483647) so it never covers it
  const btn =
    `<button id="${EDD_TERM_TOGGLE_ID}" type="button" title="Toggle terminal (on top of opencode)"` +
    ` aria-label="Toggle terminal"` +
    ` style="position:fixed;z-index:${z};bottom:12px;left:12px;display:inline-flex;align-items:center;gap:6px;` +
    `padding:8px 12px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(11,15,13,.92);` +
    `color:#4ec9b0;cursor:pointer;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;` +
    `box-shadow:0 4px 16px rgba(0,0,0,.35)">⌨ Terminal</button>`;
  const overlay =
    `<div id="${EDD_TERM_OVERLAY_ID}" hidden` +
    ` style="position:fixed;z-index:${z};left:12px;right:12px;bottom:56px;height:min(60vh,540px);` +
    `display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.22);border-radius:8px;overflow:hidden;` +
    `background:#1e1e1e;box-shadow:0 8px 32px rgba(0,0,0,.5)">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;` +
    `background:#0b0f0d;color:#4ec9b0;font:600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">` +
    `<span>Terminal</span>` +
    `<button id="${EDD_TERM_MIN_ID}" type="button" title="Minimize terminal" aria-label="Minimize terminal"` +
    ` style="background:transparent;border:0;color:#4ec9b0;cursor:pointer;font-size:16px;line-height:1;padding:0 4px">×</button>` +
    `</div>` +
    `<iframe id="${EDD_TERM_FRAME_ID}" data-src="${src}" title="Terminal"` +
    ` style="flex:1;width:100%;border:0;background:#1e1e1e"></iframe>` +
    `</div>`;
  const insertAt = bodyMatch.index + bodyMatch[0].length;
  return `${html.slice(0, insertAt)}${btn}${overlay}${html.slice(insertAt)}`;
}

/**
 * The single, UNIQUE anchor in opencode's client path-router integration `get` — it reads
 * `window.location.pathname` (served under `/w/<id>/`) so the router matches no route and the app
 * renders blank. We redirect that ONE read through `window.__eddStrip` (defined in the injected
 * shim) so the router matches as if at "/". This is a targeted exact-string replacement at a
 * verified-unique site — NOT the blanket regex that once corrupted the bundle. The `_SET` marker
 * is the router integration's `set` (also unique); its presence means "this is the router bundle",
 * so a missing `_GET` anchor is a version drift we FAIL LOUD on rather than silently serve blank.
 */
const OPENCODE_ROUTER_GET_ANCHOR = 'window.location.pathname.replace(/^\\/+/,"/")';
const OPENCODE_ROUTER_GET_PATCH =
  'window.__eddStrip(window.location.pathname).replace(/^\\/+/,"/")';
const OPENCODE_ROUTER_SET_MARKER = 'window.history.pushState(o,"",r)';

function patchOpencodeRouterBase(body: string): string {
  if (!body.includes(OPENCODE_ROUTER_SET_MARKER)) return body; // not the router bundle — leave it
  if (!body.includes(OPENCODE_ROUTER_GET_ANCHOR)) {
    // The router bundle changed shape (opencode version bump) — serving it verbatim would blank
    // the editor, so fail loud (the caller turns this into a 502 the smoke catches).
    throw new Error(
      "opencode router base-path anchor not found — the bundle changed; update patchOpencodeRouterBase",
    );
  }
  return body.replace(OPENCODE_ROUTER_GET_ANCHOR, OPENCODE_ROUTER_GET_PATCH);
}

export function rewriteOpencodeResponseBody(
  body: string,
  wsId: WorkspaceId,
  contentType: string | undefined,
): string {
  const base = opencodeRewriteBase(wsId);
  const lower = contentType?.toLowerCase();
  if (lower?.includes("text/css") === true) {
    // CSS: only `url(/...)` needs relocating. Safe here because CSS has no regex/division
    // ambiguity (unlike JS, where a call ending in "url(" followed by a regex would match).
    return body.replace(/url\(\s*\/(?!\/|w\/)/g, `url(${base}/`);
  }
  if (lower?.includes("text/html") === true) {
    // HTML: rewrite ONLY root-absolute TAG ATTRIBUTES that point at opencode's own
    // assets/APIs (`<script src="/…">`, `<link href="/…">`, `<meta … content="/…">`).
    // HTML has no regex-literal ambiguity, so an attribute-scoped rewrite is safe. The old
    // blanket "quote-then-slash" rewrite (which also ran on JS) is GONE — it was the source
    // of the bundle corruption. Everything the client requests at RUNTIME from a
    // root-absolute path is rebased by the injected shim instead.
    return body.replace(/\b(src|href|content)=(["'])\/(?!\/|w\/)/g, `$1=$2${base}/`);
  }
  if (lower?.includes("javascript") === true) {
    // JavaScript is NOT blanket-rewritten (that corrupted the bundle). The ONLY JS change is the
    // single, exact-string, verified-unique router base-path anchor — see patchOpencodeRouterBase.
    return patchOpencodeRouterBase(body);
  }
  // Any other content type is returned verbatim.
  return body;
}

/**
 * Inline JavaScript (no external deps) injected into opencode's HTML `<head>` BEFORE its
 * bundle. opencode is served at origin-root by the workspace but proxied under `/w/<id>/`,
 * and its client issues ROOT-ABSOLUTE requests (`/auth`, `/event`, `/global/*`, workers,
 * WebSockets). We cannot rewrite those in the minified bundle without corrupting it, so we
 * rebase them at RUNTIME: patch fetch/XHR/WebSocket/EventSource/Worker so a same-origin
 * root-absolute URL is prefixed with the workspace base. This operates on real URL values,
 * so — unlike a source-text rewrite — it can never produce invalid JavaScript. A classic
 * inline script in `<head>` runs during parse, before the deferred module bundle executes.
 */
export function buildOpencodeBasePathShim(base: string): string {
  // `base` is `/w/<id>` (opaque id chars only), embedded via JSON.stringify.
  return [
    "(function(){",
    `var base=${JSON.stringify(base)};`,
    // Base-path routing support (paired with the one-line JS patch in patchOpencodeRouterBase):
    // opencode's client path-router reads `window.location.pathname` (which the proxy serves under
    // `/w/<id>/`) and matches no route, so its main view never renders. `location.pathname` is an
    // [Unforgeable] property we cannot override, so the router's READ is redirected through
    // `window.__eddStrip` by a targeted bundle edit; here we (a) provide `__eddStrip` to remove the
    // base so the router matches as if at "/", and (b) wrap history.pushState/replaceState to add
    // the base back on WRITES so the real URL stays under the workspace prefix. Verified live: the
    // main UI renders and in-app navigation keeps the `/w/<id>/` prefix.
    "function __eddAddBase(u){var s=String(u);return (s.charAt(0)==='/'&&s!==base&&s.indexOf(base+'/')!==0)?base+s:s;}",
    "window.__eddStrip=function(p){if(p==null)return p;return (p===base||p.indexOf(base+'/')===0)?(p.slice(base.length)||'/'):p;};",
    "var __eddPS=history.pushState.bind(history);history.pushState=function(d,t,u){return __eddPS(d,t,u==null?u:__eddAddBase(u));};",
    "var __eddRS=history.replaceState.bind(history);history.replaceState=function(d,t,u){return __eddRS(d,t,u==null?u:__eddAddBase(u));};",
    "function rebase(u){",
    "if(u==null)return u;",
    "try{",
    "var s=typeof u==='string'?u:(u&&u.url)?u.url:String(u);",
    "var url=new URL(s,location.href);",
    "if(url.host===location.host&&url.pathname!==base&&url.pathname.indexOf(base+'/')!==0){",
    "url.pathname=base+url.pathname;return url.toString();",
    "}",
    "return s;",
    "}catch(e){return u;}",
    "}",
    "var of=window.fetch;",
    "if(of){window.fetch=function(input,init){",
    "if(typeof input==='string'||input instanceof URL){return of.call(this,rebase(String(input)),init);}",
    "if(input&&input.url){try{return of.call(this,new Request(rebase(input.url),input),init);}catch(e){return of.call(this,input,init);}}",
    "return of.call(this,input,init);",
    "};}",
    "var ox=XMLHttpRequest.prototype.open;",
    "XMLHttpRequest.prototype.open=function(m,u){arguments[1]=rebase(u);return ox.apply(this,arguments);};",
    "var OW=window.WebSocket;",
    "if(OW){var NW=function(u,p){return p===undefined?new OW(rebase(u)):new OW(rebase(u),p);};NW.prototype=OW.prototype;NW.CONNECTING=OW.CONNECTING;NW.OPEN=OW.OPEN;NW.CLOSING=OW.CLOSING;NW.CLOSED=OW.CLOSED;window.WebSocket=NW;}",
    "if(window.EventSource){var OE=window.EventSource;var NE=function(u,c){return new OE(rebase(u),c);};NE.prototype=OE.prototype;NE.CONNECTING=OE.CONNECTING;NE.OPEN=OE.OPEN;NE.CLOSED=OE.CLOSED;window.EventSource=NE;}",
    "if(window.Worker){var OWk=window.Worker;var NWk=function(u,o){return new OWk(rebase(u),o);};NWk.prototype=OWk.prototype;window.Worker=NWk;}",
    // Force the injected EDD home link to escape opencode's SPA router. opencode
    // (SolidJS) installs a document click handler that preventDefaults same-origin anchor
    // clicks for client-side routing, which swallows a plain `<a href="/workspaces">`
    // navigation. A capture-phase listener registered here (before opencode's) intercepts
    // the click first and performs a real top-level navigation. Inline onclick can't be
    // used — opencode's hash-based CSP blocks inline event handlers.
    // Terminal overlay (injected by injectOpencodeTerminalOverlay): show/hide on top of opencode.
    // The iframe's `src` is set from `data-src` on first open so no PTY connects until asked. CSP
    // blocks inline handlers, so wiring happens here (this whole script's hash is CSP-whitelisted).
    "function __eddTermSet(show){var o=document.getElementById('edd-term-overlay');if(!o)return;",
    "if(show){var f=document.getElementById('edd-term-frame');if(f&&!f.getAttribute('src')){f.setAttribute('src',f.getAttribute('data-src'));}o.removeAttribute('hidden');}",
    "else{o.setAttribute('hidden','');}",
    "var b=document.getElementById('edd-term-toggle');if(b){b.setAttribute('aria-pressed',show?'true':'false');}}",
    "document.addEventListener('click',function(e){",
    "var t=e.target;if(!t||!t.closest)return;",
    "var a=t.closest('#edd-workspaces-home,#edd-home');",
    "if(a){e.preventDefault();e.stopImmediatePropagation();window.location.assign(a.getAttribute('href')||'/workspaces');return;}",
    "if(t.closest('#edd-term-toggle')){e.preventDefault();e.stopImmediatePropagation();var o=document.getElementById('edd-term-overlay');__eddTermSet(!!o&&o.hasAttribute('hidden'));return;}",
    "if(t.closest('#edd-term-min')){e.preventDefault();e.stopImmediatePropagation();__eddTermSet(false);return;}",
    "},true);",
    "})();",
  ].join("");
}

/**
 * Inject the base-path shim into opencode's HTML `<head>` and return the new HTML plus the
 * exact script source (so the caller can whitelist its hash in the response CSP). Fails
 * loud if the HTML has no `<head>` — opencode without the shim is non-functional (all its
 * root-absolute API/WS calls would escape the workspace), so a silent pass is not allowed.
 */
export function injectOpencodeBasePathShim(
  html: string,
  wsId: WorkspaceId,
): { html: string; scriptSource: string } {
  const scriptSource = buildOpencodeBasePathShim(opencodeRewriteBase(wsId));
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch === null) {
    throw new Error("opencode HTML did not contain a <head> tag for the base-path shim");
  }
  const insertAt = headMatch.index + headMatch[0].length;
  const tag = `<script>${scriptSource}</script>`;
  return { html: `${html.slice(0, insertAt)}${tag}${html.slice(insertAt)}`, scriptSource };
}

/**
 * Add an inline script's `sha256` to a CSP so an injected inline `<script>` is allowed
 * under opencode's hash-based policy. The hash is added to `script-src-elem` and
 * `script-src` when present; if neither directive exists there is nothing to satisfy and
 * the CSP is returned unchanged. Never widens the policy beyond this one script.
 */
export function cspAllowingInlineScript(csp: string, scriptSource: string): string {
  const hash = `'sha256-${createHash("sha256").update(scriptSource, "utf8").digest("base64")}'`;
  const isScriptDirective = (d: string): boolean => {
    const name = d.split(/\s+/)[0]?.toLowerCase();
    return name === "script-src" || name === "script-src-elem";
  };
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  // Nothing to satisfy: no script directive means no restriction to whitelist against.
  if (!directives.some(isScriptDirective)) return csp;
  return directives
    .map((d) => (isScriptDirective(d) && !d.includes(hash) ? `${d} ${hash}` : d))
    .join("; ");
}

/**
 * Ensure a same-origin `<iframe>` (the terminal overlay) is allowed under opencode's CSP: add
 * `'self'` to `frame-src` when that directive exists (frames otherwise fall back to `child-src`
 * then `default-src`, but an explicit restrictive `frame-src` would block the overlay). Only
 * touches an existing `frame-src`; never adds the directive or widens anything else.
 */
export function cspAllowingSelfFrame(csp: string): string {
  const isFrameDirective = (d: string): boolean => d.split(/\s+/)[0]?.toLowerCase() === "frame-src";
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  if (!directives.some(isFrameDirective)) return csp;
  return directives
    .map((d) => (isFrameDirective(d) && !/(^|\s)'self'(\s|$)/.test(d) ? `${d} 'self'` : d))
    .join("; ");
}

/** http.request options forwarding `req` to the workspace `upstream`. OpenVSCode,
 * OpenVSCode, Monaco, and Terminal serve under `/w/<id>/`, so paths pass through. opencode
 * has no base-path flag, so only that editor is translated to origin-root upstream
 * paths and authenticated with the workspace connection token as Basic auth. */
function upstreamOptions(
  upstream: URL,
  req: IncomingMessage,
  context?: WorkspaceProxyContext,
): RequestOptions {
  const headers = { ...req.headers, host: upstream.host };
  // Never forward the portal Auth.js session cookie into the workspace container.
  const cookie = stripSessionCookie(headerValue(req.headers.cookie));
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  if (context?.editor === "opencode") {
    const secret = process.env[CONNECTION_SECRET_ENV] ?? "";
    headers.authorization = opencodeProxyAuthorization(secret, context.wsId);
  } else {
    delete headers.authorization;
  }
  if (context?.editor === "opencode" || context?.editor === "openvscode") {
    delete headers["accept-encoding"];
  }
  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path:
      context === undefined
        ? req.url
        : workspaceProxyRequestPath(context.editor, context.wsId, req.url),
    headers,
  };
}

/** Forward an authorized ordinary HTTP request to the upstream, streaming both ways. */
export function proxyWorkspaceHttp(
  upstream: URL,
  req: IncomingMessage,
  res: ServerResponse,
  context?: WorkspaceProxyContext,
): void {
  const proxyReq = httpRequest(upstreamOptions(upstream, req, context), (proxyRes) => {
    if (context === undefined) {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    const contentType = headerValue(proxyRes.headers["content-type"]);
    const injectOpenVscodeHome = context.editor === "openvscode" && responseIsHtml(contentType);
    if (context.editor !== "opencode" && !injectOpenVscodeHome) {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    // opencode additionally buffers its JS bundle so the single, exact-string router base-path
    // anchor can be patched (see patchOpencodeRouterBase); every other editor still buffers only
    // html/css. JS for any other editor is never buffered (streamed verbatim).
    const canRewrite =
      context.editor === "opencode"
        ? responseCanBeRewritten(contentType) || responseIsJavaScript(contentType)
        : responseCanBeRewritten(contentType);
    if (!canRewrite) {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let overCap = false;
    proxyRes.on("data", (chunk: Buffer | string) => {
      if (overCap) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bufferedBytes += buf.length;
      if (bufferedBytes > WORKSPACE_PROXY_MAX_REWRITE_BYTES) {
        // Refuse to buffer an unbounded body into the shared control plane's heap.
        // Fail loud (502) rather than OOM; drop the chunks so they can be GC'd.
        overCap = true;
        chunks.length = 0;
        log.warn("workspace-proxy rewrite body exceeded cap", {
          wsId: context.wsId,
          cap: WORKSPACE_PROXY_MAX_REWRITE_BYTES,
        });
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("upstream response too large to process");
        proxyRes.destroy();
        return;
      }
      chunks.push(buf);
    });
    proxyRes.on("end", () => {
      if (overCap) return;
      const headers = { ...proxyRes.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      try {
        const content = Buffer.concat(chunks).toString("utf8");
        let outBody =
          context.editor === "opencode"
            ? rewriteOpencodeResponseBody(content, context.wsId, contentType)
            : content;
        if (responseIsHtml(contentType)) {
          outBody = injectWorkspaceHomeLink(outBody, context.editor);
          if (context.editor === "opencode") {
            // Add the terminal overlay (button + on-top iframe) BEFORE the shim, so the shim's
            // capture-phase click handler can wire the toggle/minimize buttons it introduces.
            outBody = injectOpencodeTerminalOverlay(outBody, context.wsId);
            // Inject the runtime base-path shim and whitelist its hash in the response CSP
            // (opencode ships a hash-based script-src, so an un-hashed inline script would
            // be blocked). Header mutation must happen BEFORE writeHead below.
            const shimmed = injectOpencodeBasePathShim(outBody, context.wsId);
            outBody = shimmed.html;
            for (const cspHeader of [
              "content-security-policy",
              "content-security-policy-report-only",
            ]) {
              const value = headerValue(headers[cspHeader]);
              if (value !== undefined) {
                headers[cspHeader] = cspAllowingSelfFrame(
                  cspAllowingInlineScript(value, shimmed.scriptSource),
                );
              }
            }
          }
        }
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        res.end(outBody);
      } catch (e) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(e instanceof Error ? e.message : "opencode response rewrite failed");
      }
    });
    proxyRes.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
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
  context?: WorkspaceProxyContext,
): void {
  const proxyReq = httpRequest(upstreamOptions(upstream, req, context));
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
