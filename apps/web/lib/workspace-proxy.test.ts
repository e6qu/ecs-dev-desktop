// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import vm from "node:vm";

import { deriveWorkspaceToken, workspaceId } from "@edd/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CookieBearingRequest } from "./workspace-proxy";

// The shell wiring of the in-app `/w/<id>/` proxy authorizer: decode the Auth.js
// session (getToken) + load the workspace (control plane), then defer to the pure
// `decideWorkspaceAccessBySubject` (exhaustively unit-tested in @edd/core). Here we
// pin the GLUE: unauthenticated → redirect to login, unknown ws → forbidden, and
// owner/admin/other map to the right outcome. Both edges are mocked so the test is
// hermetic and controls its own inputs (no DB, no real cookie).
const { getTokenMock, inspectMock, validateAuthSessionTokenMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn<() => Promise<{ uid?: string; role?: string; exp?: number } | null>>(),
  inspectMock:
    vi.fn<() => Promise<{ workspace: { ownerId: string; shareEnabled?: boolean } } | null>>(),
  validateAuthSessionTokenMock:
    vi.fn<
      () => Promise<{ id: string; ownerId: string; role: string; expiresAtMs: number } | null>
    >(),
}));
vi.mock("next-auth/jwt", () => ({ getToken: getTokenMock }));
vi.mock("./auth-sessions", () => ({ validateAuthSessionToken: validateAuthSessionTokenMock }));
vi.mock("./control-plane", () => ({
  getControlPlane: vi.fn(() => Promise.resolve({ inspect: inspectMock })),
}));
// authorizeWorkspace stamps control-plane activity (fire-and-forget) on a granted
// request; stub it so the authz tests don't drag in the control-plane activity graph.
vi.mock("./system-activity", () => ({ recordSystemActivity: vi.fn(() => Promise.resolve()) }));

const {
  authorizeSpectate,
  authorizeWorkspace,
  buildOpencodeBasePathShim,
  cspAllowingInlineScript,
  editorTokenRedirect,
  injectOpencodeBasePathShim,
  injectWorkspaceHomeLink,
  isDocumentNavigation,
  isWorkspaceDocumentNavigation,
  opencodeProxyAuthorization,
  rewriteOpencodeResponseBody,
  stripSessionCookie,
  workspaceProxyRequestPath,
} = await import("./workspace-proxy");

const WS = workspaceId("ws-abc123");
const req = (cookie = "session=x"): CookieBearingRequest => ({ headers: { cookie } });

beforeEach(() => {
  getTokenMock.mockReset();
  inspectMock.mockReset();
  validateAuthSessionTokenMock.mockReset();
  validateAuthSessionTokenMock.mockResolvedValue({
    id: "auth-session-1",
    ownerId: "u-1",
    role: "developer",
    expiresAtMs: 1_900_000_000_000,
  });
  // authorizeWorkspace now fails loud without AUTH_SECRET (getToken itself is mocked).
  process.env.AUTH_SECRET = "test-secret";
});
afterEach(() => {
  delete process.env.AUTH_SECRET;
});

describe("authorizeWorkspace (in-app proxy authz glue)", () => {
  it("is unauthenticated when there is no valid session (→ redirect to login)", async () => {
    getTokenMock.mockResolvedValue(null);
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "unauthenticated" });
    expect(inspectMock).not.toHaveBeenCalled(); // never touches the control plane unauthenticated
  });

  it("is unauthenticated when the signed cookie has no active server-side session", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1", role: "developer" });
    validateAuthSessionTokenMock.mockResolvedValue(null);
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "unauthenticated" });
    expect(inspectMock).not.toHaveBeenCalled();
  });

  it("is forbidden (not 404) for an unknown workspace — does not distinguish existence", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1" });
    inspectMock.mockResolvedValue(null);
    expect(await authorizeWorkspace(req(), WS)).toMatchObject({ kind: "forbidden" });
  });

  it("fails loud (throws) when AUTH_SECRET is unset — never authorizes with an empty secret", async () => {
    delete process.env.AUTH_SECRET;
    getTokenMock.mockResolvedValue({ uid: "u-1" });
    await expect(authorizeWorkspace(req(), WS)).rejects.toThrow(/AUTH_SECRET/);
  });

  it("allows the owner (session uid === workspace ownerId)", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1", exp: 1_900_000_000 });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-1" } });
    // `allow` carries the session's exp (seconds -> ms) so presence tracking can
    // cap how long a held connection counts as "user present".
    expect(await authorizeWorkspace(req(), WS)).toMatchObject({
      kind: "allow",
      sessionExpiresAtMs: 1_900_000_000_000,
    });
  });

  it("forbids a different authenticated user", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-2" } });
    expect(await authorizeWorkspace(req(), WS)).toMatchObject({ kind: "forbidden" });
  });

  it("allows an admin to reach a workspace they do not own", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1", role: "admin" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-2" } });
    expect(await authorizeWorkspace(req(), WS)).toMatchObject({ kind: "allow" });
  });

  it("forbids a non-admin whose session carries no subject (fails closed)", async () => {
    getTokenMock.mockResolvedValue({ role: "developer" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-1" } });
    expect(await authorizeWorkspace(req(), WS)).toMatchObject({ kind: "forbidden" });
  });
});

// The connection-token handoff: behind the session-authorizing proxy, the browser's
// initial navigation to the editor is redirected to carry the per-workspace token, so
// the workbench loads without the user ever handling it. Exercises every gate that
// decides whether to inject (secret configured, document nav, no token yet).
describe("isDocumentNavigation (status-page hand-off gate)", () => {
  it("is true for a top-level document navigation (sec-fetch-dest)", () => {
    expect(isDocumentNavigation({ headers: { "sec-fetch-dest": "document" } })).toBe(true);
  });
  it("is true when there's no sec-fetch-dest but the browser accepts text/html", () => {
    expect(isDocumentNavigation({ headers: { accept: "text/html,application/xhtml+xml" } })).toBe(
      true,
    );
  });
  it("is false for the editor's own sub-resource/API requests (script/fetch)", () => {
    expect(isDocumentNavigation({ headers: { "sec-fetch-dest": "script" } })).toBe(false);
    expect(isDocumentNavigation({ headers: { "sec-fetch-dest": "empty" } })).toBe(false);
  });
});

describe("isWorkspaceDocumentNavigation (status-page hand-off gate)", () => {
  it("is true for sparse-header direct opens of the workspace root", () => {
    expect(isWorkspaceDocumentNavigation({ url: `/w/${WS}/`, headers: {} }, WS)).toBe(true);
    expect(isWorkspaceDocumentNavigation({ url: `/w/${WS}`, headers: {} }, WS)).toBe(true);
  });

  it("is false for sparse-header editor sub-resource/API requests", () => {
    expect(isWorkspaceDocumentNavigation({ url: `/w/${WS}/api/tree`, headers: {} }, WS)).toBe(
      false,
    );
  });

  it("still honors standard document navigation headers on any workspace path", () => {
    expect(
      isWorkspaceDocumentNavigation(
        { url: `/w/${WS}/static/out/main.js`, headers: { "sec-fetch-dest": "document" } },
        WS,
      ),
    ).toBe(true);
  });
});

describe("editorTokenRedirect (editor connection-token handoff)", () => {
  const SECRET = randomBytes(16).toString("hex");
  const expectedTkn = deriveWorkspaceToken(SECRET, WS);
  const docHeaders = (extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({
    "sec-fetch-dest": "document",
    ...extra,
  });

  beforeEach(() => {
    vi.stubEnv("EDD_CONNECTION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects a top-level document navigation to carry ?tkn=<per-workspace token>", () => {
    const out = editorTokenRedirect({ method: "GET", url: `/w/${WS}/`, headers: docHeaders() }, WS);
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("preserves an existing query when appending the token", () => {
    const out = editorTokenRedirect(
      { method: "GET", url: `/w/${WS}/?folder=/home/workspace`, headers: docHeaders() },
      WS,
    );
    expect(out).toBe(`/w/${WS}/?folder=%2Fhome%2Fworkspace&tkn=${expectedTkn}`);
  });

  it("treats an HTML Accept (no Sec-Fetch-Dest) as a document navigation", () => {
    const out = editorTokenRedirect(
      { method: "GET", url: `/w/${WS}/`, headers: { accept: "text/html,application/xhtml+xml" } },
      WS,
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("treats the bare workspace root as a document navigation even when browser headers are sparse", () => {
    const out = editorTokenRedirect({ method: "GET", url: `/w/${WS}/`, headers: {} }, WS);
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("does not treat non-root workspace paths as document navigations without document headers", () => {
    const out = editorTokenRedirect({ method: "GET", url: `/w/${WS}/api/tree`, headers: {} }, WS);
    expect(out).toBeUndefined();
  });

  it("does not redirect when the request already carries the token (no loop)", () => {
    const out = editorTokenRedirect(
      { method: "GET", url: `/w/${WS}/?tkn=${expectedTkn}`, headers: docHeaders() },
      WS,
    );
    expect(out).toBeUndefined();
  });

  it("overwrites a stale token query for a different workspace", () => {
    const out = editorTokenRedirect(
      { method: "GET", url: `/w/${WS}/?tkn=stale-token`, headers: docHeaders() },
      WS,
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("does not redirect once the editor token cookie is established", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `vscode-tkn=${expectedTkn}` }),
      },
      WS,
    );
    expect(out).toBeUndefined();
  });

  it("does not use the OpenVSCode token-query handoff for opencode", () => {
    const out = editorTokenRedirect(
      { method: "GET", url: `/w/${WS}/`, headers: docHeaders() },
      WS,
      "opencode",
    );
    expect(out).toBeUndefined();
  });

  it("does not let a stale OpenVSCode token cookie suppress token injection", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: "vscode-tkn=stale-token" }),
      },
      WS,
      "openvscode",
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("recognizes the Monaco server's edd-editor-token cookie only for Monaco workspaces", () => {
    // The Monaco editor server sets edd-editor-token, not vscode-tkn. Without
    // recognizing it, the proxy kept re-injecting ?tkn and then forwarded a clean
    // request the Monaco server rejected with 401.
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `edd-editor-token=${expectedTkn}` }),
      },
      WS,
      "monaco",
    );
    expect(out).toBeUndefined();
  });

  it("does not let a stale Monaco token cookie suppress Monaco token injection", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: "edd-editor-token=stale-token" }),
      },
      WS,
      "monaco",
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("does not let a Monaco cookie suppress OpenVSCode token injection", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `edd-editor-token=${expectedTkn}` }),
      },
      WS,
      "openvscode",
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("does not let an OpenVSCode cookie suppress Monaco token injection", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `vscode-tkn=${expectedTkn}` }),
      },
      WS,
      "monaco",
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("recognizes the Monaco token cookie for Terminal workspaces", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `edd-editor-token=${expectedTkn}` }),
      },
      WS,
      "terminal",
    );
    expect(out).toBeUndefined();
  });

  it("does not let an OpenVSCode cookie suppress Terminal token injection", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `vscode-tkn=${expectedTkn}` }),
      },
      WS,
      "terminal",
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("does not let a stale removed vendor cookie suppress OpenVSCode token injection", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/`,
        headers: docHeaders({ cookie: `edd-vendor-token=${expectedTkn}` }),
      },
      WS,
      "openvscode",
    );
    expect(out).toBe(`/w/${WS}/?tkn=${expectedTkn}`);
  });

  it("does not redirect the editor's own sub-resource/API requests", () => {
    const out = editorTokenRedirect(
      {
        method: "GET",
        url: `/w/${WS}/static/out/main.js`,
        headers: { "sec-fetch-dest": "script" },
      },
      WS,
    );
    expect(out).toBeUndefined();
  });

  it("does not redirect a non-GET request", () => {
    const out = editorTokenRedirect(
      { method: "POST", url: `/w/${WS}/`, headers: docHeaders() },
      WS,
    );
    expect(out).toBeUndefined();
  });

  it("forwards as-is (no token) when no connection secret is configured — tokenless/dev", () => {
    vi.stubEnv("EDD_CONNECTION_SECRET", "");
    const out = editorTokenRedirect({ method: "GET", url: `/w/${WS}/`, headers: docHeaders() }, WS);
    expect(out).toBeUndefined();
  });
});

describe("opencode proxy adaptation", () => {
  const SECRET = randomBytes(16).toString("hex");

  it("strips the workspace path prefix because opencode serves at origin root", () => {
    expect(workspaceProxyRequestPath("opencode", WS, `/w/${WS}/`)).toBe("/");
    expect(workspaceProxyRequestPath("opencode", WS, `/w/${WS}/assets/app.js`)).toBe(
      "/assets/app.js",
    );
    expect(workspaceProxyRequestPath("opencode", WS, `/w/${WS}/global/health?x=1`)).toBe(
      "/global/health?x=1",
    );
  });

  it("preserves paths unchanged for base-path-aware editors", () => {
    expect(workspaceProxyRequestPath("openvscode", WS, `/w/${WS}/static/out/main.js`)).toBe(
      `/w/${WS}/static/out/main.js`,
    );
  });

  it("fails loudly if an opencode request path is outside its workspace prefix", () => {
    expect(() => workspaceProxyRequestPath("opencode", WS, "/assets/app.js")).toThrow(
      /outside workspace prefix/,
    );
  });

  it("injects Basic auth from the same derived workspace connection token", () => {
    const expectedToken = deriveWorkspaceToken(SECRET, WS);
    const encoded = Buffer.from(`opencode:${expectedToken}`, "utf8").toString("base64");
    expect(opencodeProxyAuthorization(SECRET, WS)).toBe(`Basic ${encoded}`);
  });

  it("fails loudly when opencode auth cannot be derived", () => {
    expect(() => opencodeProxyAuthorization("", WS)).toThrow(/required/);
  });

  it("rewrites opencode HTML tag attributes only — never non-attribute string paths", () => {
    const input = [
      '<script src="/assets/index.js"></script>',
      '<link href="/assets/index.css">',
      '<meta name="x" content="/global/config">',
      'const worker="/assets/worker.js";', // inline string, NOT an attribute → left for the shim
      'const already="/w/not-this-workspace/assets/existing.js";',
      'const external="https://opencode.ai/logo.png";',
    ].join("\n");
    const out = rewriteOpencodeResponseBody(input, WS, "text/html");
    // Static tag attributes are relocated (safe: HTML has no regex ambiguity).
    expect(out).toContain(`src="/w/${WS}/assets/index.js"`);
    expect(out).toContain(`href="/w/${WS}/assets/index.css"`);
    expect(out).toContain(`content="/w/${WS}/global/config"`);
    // Non-attribute string paths are NOT rewritten — the runtime shim rebases those.
    expect(out).toContain('const worker="/assets/worker.js";');
    // Already-prefixed and external references are untouched.
    expect(out).toContain('"/w/not-this-workspace/assets/existing.js"');
    expect(out).toContain('"https://opencode.ai/logo.png"');
  });

  it("returns a JS bundle VERBATIM — no byte-level rewrite can corrupt it", () => {
    // The live failure: the old blanket `(["'])\/` rewrite injected `/w/<id>/` into
    // string/regex literals of a 2.78 MB minified bundle → "Invalid regular expression
    // flags" → blank page. JS must now pass through unchanged (proxy never buffers it).
    const js =
      'const m=parseurl(/[a-z]+/g);const n=curl(/x/);a.src="/logo.png";fetch("/global/health");';
    const out = rewriteOpencodeResponseBody(js, WS, "application/javascript");
    expect(out).toBe(js); // byte-for-byte identical
    expect(out).not.toContain(`/w/${WS}/`);
  });

  it('leaves the EXACT prod bundle pattern that broke (`replace(/"/g,…)`) valid', () => {
    // Captured verbatim from the live opencode bundle the old rewrite corrupted: it turned
    // `.replace(/"/g,"&quot;")` into `.replace(/"/w/<id>/g,"&quot;")` — `/w/` with flags
    // `ws-…` → "Invalid regular expression flags". Our rewrite must not touch it.
    const js =
      'function KMe(e){return e.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;")}';
    expect(rewriteOpencodeResponseBody(js, WS, "text/javascript")).toBe(js);
    expect(
      () => new vm.Script(rewriteOpencodeResponseBody(js, WS, "text/javascript")),
    ).not.toThrow();
  });

  it("transforms a realistic opencode HTML shell into a valid shimmed document", () => {
    // Mirrors the real prod shell: <head> with an inline classic script + the module
    // bundle + a stylesheet link, and an empty <div id="root"> the SPA mounts into.
    const shell = [
      "<!doctype html><html><head>",
      "<title>OpenCode</title>",
      '<script id="oc-theme">;(function(){localStorage.getItem("opencode-theme-id")})()</script>',
      '<script type="module" crossorigin src="/assets/index-DMJ0TRh9.js"></script>',
      '<link rel="stylesheet" href="/assets/index.css">',
      '</head><body><div id="root"></div></body></html>',
    ].join("");
    let html = rewriteOpencodeResponseBody(shell, WS, "text/html");
    html = injectWorkspaceHomeLink(html, "opencode");
    const { html: shimmed, scriptSource } = injectOpencodeBasePathShim(html, WS);
    // The module bundle + stylesheet are relocated under the workspace path…
    expect(shimmed).toContain(`src="/w/${WS}/assets/index-DMJ0TRh9.js"`);
    expect(shimmed).toContain(`href="/w/${WS}/assets/index.css"`);
    // …the shim is injected and runs before the module bundle…
    expect(shimmed.indexOf(scriptSource)).toBeLessThan(shimmed.indexOf('type="module"'));
    // …the home link is present…
    expect(shimmed).toContain('id="edd-workspaces-home"');
    // …opencode's own inline theme script is left byte-for-byte intact…
    expect(shimmed).toContain('localStorage.getItem("opencode-theme-id")');
    // …and the injected shim is valid JS.
    expect(() => new vm.Script(scriptSource)).not.toThrow();
  });

  it("rewrites url(/...) in CSS but leaves CSS string paths alone", () => {
    const css = ".x{background:url(/assets/bg.png)}.y{content:'/not-a-url'}";
    const out = rewriteOpencodeResponseBody(css, WS, "text/css");
    expect(out).toContain(`url(/w/${WS}/assets/bg.png)`);
    // CSS is not JS/HTML: the string-path rewrite must not run here.
    expect(out).toContain("content:'/not-a-url'");
  });

  it("injects a visible EDD workspaces link into opencode HTML without rewriting it", () => {
    const out = injectWorkspaceHomeLink(
      rewriteOpencodeResponseBody(
        "<!doctype html><html><body><main>opencode</main></body></html>",
        WS,
        "text/html",
      ),
      "opencode",
    );
    expect(out).toContain('id="edd-workspaces-home"');
    expect(out).toContain('href="/workspaces"');
    expect(out).toContain("EDD home");
    expect(out).not.toContain(`href="/w/${WS}/workspaces"`);
    // opencode's message input is at the bottom, so its home pill stays top-left.
    expect(out).toContain("top:10px;left:10px");
  });

  it("anchors the OpenVSCode home link to the bottom so it never covers the menu bar", () => {
    // The File/Edit/… menu bar is top-left; a top-left pill intercepted its click
    // (found live). OpenVSCode's pill must sit at the bottom instead.
    const out = injectWorkspaceHomeLink(
      "<!doctype html><html><body><div class='monaco-workbench'></div></body></html>",
      "openvscode",
    );
    expect(out).toContain('id="edd-workspaces-home"');
    expect(out).toContain("bottom:28px;left:12px");
    expect(out).not.toContain("top:10px;left:10px");
  });

  it("does not silently pass opencode HTML that cannot receive the required EDD navigation", () => {
    expect(() =>
      injectWorkspaceHomeLink("<!doctype html><html><main>opencode</main></html>", "opencode"),
    ).toThrow(/body/);
  });
});

describe("opencode base-path shim", () => {
  it("builds valid JavaScript that patches fetch/XHR/WebSocket/EventSource/Worker", () => {
    const shim = buildOpencodeBasePathShim(`/w/${WS}`);
    // Must COMPILE as valid JS (the whole point — a source rewrite could not guarantee
    // this; a byte-level bundle rewrite is exactly what produced invalid JS in prod).
    expect(() => new vm.Script(shim)).not.toThrow();
    expect(shim).toContain(`var base=${JSON.stringify(`/w/${WS}`)};`);
    for (const api of [
      "window.fetch",
      "XMLHttpRequest.prototype.open",
      "window.WebSocket",
      "window.EventSource",
      "window.Worker",
    ]) {
      expect(shim).toContain(api);
    }
  });

  it("wires a capture-phase handler so the EDD home link escapes opencode's SPA router", () => {
    const shim = buildOpencodeBasePathShim(`/w/${WS}`);
    // Capture-phase document click listener that targets the injected home link and forces
    // a real navigation (opencode preventDefaults same-origin anchor clicks otherwise).
    expect(shim).toContain("addEventListener('click'");
    expect(shim).toContain("#edd-workspaces-home");
    expect(shim).toContain("stopImmediatePropagation");
    expect(shim).toContain("window.location.assign");
    expect(shim).toMatch(/},\s*true\);/); // registered with useCapture=true
    expect(() => new vm.Script(shim)).not.toThrow();
  });

  it("rebases same-origin root-absolute URLs but leaves prefixed/external/protocol-relative ones", () => {
    // Execute the real shim in an isolated VM context with a faked window/location, then
    // drive the patched fetch to observe how each URL is rebased.
    const shim = buildOpencodeBasePathShim(`/w/${WS}`);
    const calls: string[] = [];
    const fetchProbe = (u: unknown): void => {
      calls.push(String(u));
    };
    const location = { host: "app.edd.example", href: "https://app.edd.example/w/ws-abc123/" };
    const windowObj: Record<string, unknown> = { fetch: fetchProbe };
    const sandbox: Record<string, unknown> = {
      window: windowObj,
      location,
      history: { pushState: () => undefined, replaceState: () => undefined },
      URL,
      Request,
      document: { addEventListener: () => undefined },
      XMLHttpRequest: class {
        open(): void {
          /* noop */
        }
      },
      WebSocket: undefined,
      EventSource: undefined,
      Worker: undefined,
    };
    vm.runInNewContext(shim, sandbox);
    const patched = windowObj.fetch as (u: unknown) => void;
    for (const u of [
      "/global/health",
      "/w/ws-abc123/already",
      "https://cdn.example/x.png",
      "//proto-relative/x",
    ]) {
      patched(u);
    }
    expect(calls).toEqual([
      `https://app.edd.example/w/${WS}/global/health`,
      "/w/ws-abc123/already",
      "https://cdn.example/x.png",
      "//proto-relative/x",
    ]);
  });

  it("injects the shim into <head> and reports the exact script source", () => {
    const { html, scriptSource } = injectOpencodeBasePathShim(
      "<!doctype html><html><head><title>OpenCode</title></head><body></body></html>",
      WS,
    );
    expect(html).toContain(`<script>${scriptSource}</script>`);
    // The shim runs BEFORE opencode's own scripts: it sits at the very start of <head>.
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<title>"));
  });

  it("fails loud when opencode HTML has no <head> for the shim", () => {
    expect(() => injectOpencodeBasePathShim("<html><body>x</body></html>", WS)).toThrow(/head/);
  });

  it("whitelists the injected script's sha256 in a hash-based CSP script-src", () => {
    const { scriptSource } = injectOpencodeBasePathShim(
      "<html><head></head><body></body></html>",
      WS,
    );
    const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'";
    const out = cspAllowingInlineScript(csp, scriptSource);
    expect(out).toMatch(/script-src [^;]*'sha256-[A-Za-z0-9+/=]+'/);
    // Only script-src is widened; default-src is untouched.
    expect(out).toContain("default-src 'self'");
    // Idempotent: applying twice does not duplicate the hash.
    expect(cspAllowingInlineScript(out, scriptSource)).toBe(out);
  });

  it("leaves a CSP without a script directive unchanged (nothing to satisfy)", () => {
    const csp = "default-src 'self'; img-src *";
    expect(cspAllowingInlineScript(csp, "x")).toBe(csp);
  });

  it("provides __eddStrip and wraps history for base-path routing", () => {
    const shim = buildOpencodeBasePathShim(`/w/${WS}`);
    expect(shim).toContain("window.__eddStrip=");
    expect(shim).toContain("history.pushState=");
    expect(shim).toContain("history.replaceState=");
    expect(() => new vm.Script(shim)).not.toThrow();
    // Execute in a VM with a fake history + location and verify strip removes the base while
    // history writes re-add it.
    const pushed: string[] = [];
    const win: Record<string, unknown> = {};
    // The shim reassigns `history.pushState` on this object to its base-adding wrapper.
    const hist = {
      pushState: (_d: unknown, _t: unknown, u: string): void => {
        pushed.push(`push:${u}`);
      },
      replaceState: (_d: unknown, _t: unknown, u: string): void => {
        pushed.push(`replace:${u}`);
      },
    };
    const sandbox: Record<string, unknown> = {
      window: win,
      location: { host: "h", href: `https://h/w/${WS}/` },
      history: hist,
      URL,
      Request,
      document: { addEventListener: () => undefined },
      XMLHttpRequest: class {
        open(): void {
          /* noop */
        }
      },
      fetch: undefined,
      WebSocket: undefined,
      EventSource: undefined,
      Worker: undefined,
    };
    vm.runInNewContext(shim, sandbox);
    const strip = win.__eddStrip as (p: string) => string;
    expect(strip(`/w/${WS}/session/x`)).toBe("/session/x");
    expect(strip(`/w/${WS}`)).toBe("/");
    expect(strip("/other")).toBe("/other"); // not under base — unchanged
    // The wrapper (now installed on `hist`) re-adds the base on write.
    hist.pushState(null, "", "/session/y");
    expect(pushed).toEqual([`push:/w/${WS}/session/y`]);
  });
});

// The ONLY JS the proxy touches: opencode's router path-integration `get`, redirected through
// __eddStrip so the SPA router matches under the /w/<id>/ proxy prefix (paired with the shim).
describe("opencode router base-path patch (rewriteOpencodeResponseBody, JS)", () => {
  const routerBundle =
    'function Z0e(e){const t=()=>{const r=window.location.pathname.replace(/^\\/+/,"/")+window.location.search;return{value:r}};' +
    'return q0e({get:t,set({value:r,replace:i}){i?window.history.replaceState(w0e(o),"",r):window.history.pushState(o,"",r)}})}';

  it("redirects the router's path read through __eddStrip (exact, unique anchor)", () => {
    const out = rewriteOpencodeResponseBody(routerBundle, WS, "text/javascript");
    expect(out).toContain('window.__eddStrip(window.location.pathname).replace(/^\\/+/,"/")');
    // The unpatched anchor is gone (the read now routes through __eddStrip).
    expect(out).not.toContain('window.location.pathname.replace(/^\\/+/,"/")');
    // Still valid JavaScript (the whole point of a targeted edit over a blanket rewrite).
    expect(() => new vm.Script(out)).not.toThrow();
  });

  it("leaves non-router JavaScript byte-for-byte untouched", () => {
    const js = 'const x="/a/b";const re=/foo\\/bar/g;fetch("/api");';
    expect(rewriteOpencodeResponseBody(js, WS, "text/javascript")).toBe(js);
  });

  it("fails loud if the router bundle no longer has the expected anchor (version drift)", () => {
    // Has the `set` marker (so it IS the router bundle) but the `get` anchor changed.
    const drifted =
      'function Z(){return q({get:()=>readPathSomeNewWay(),set({value:r}){window.history.pushState(o,"",r)}})}';
    expect(() => rewriteOpencodeResponseBody(drifted, WS, "text/javascript")).toThrow(
      /anchor not found/,
    );
  });
});

// The portal Auth.js session JWT must never reach the workspace container (it runs
// user-supplied code/extensions; the session credential authorizes the control-plane
// API). stripSessionCookie removes it from the forwarded Cookie header while keeping
// everything else (notably the editor's own `vscode-tkn`).
describe("stripSessionCookie", () => {
  it("drops the Auth.js session token (plain + __Secure- + chunked) and keeps other cookies", () => {
    expect(stripSessionCookie("authjs.session-token=abc; vscode-tkn=xyz")).toBe("vscode-tkn=xyz");
    expect(stripSessionCookie("__Secure-authjs.session-token=abc; vscode-tkn=xyz")).toBe(
      "vscode-tkn=xyz",
    );
    expect(
      stripSessionCookie("authjs.session-token.0=aa; authjs.session-token.1=bb; vscode-tkn=xyz"),
    ).toBe("vscode-tkn=xyz");
  });

  it("returns undefined when only the session cookie was present (nothing left to forward)", () => {
    expect(stripSessionCookie("__Secure-authjs.session-token=abc")).toBeUndefined();
    expect(stripSessionCookie(undefined)).toBeUndefined();
  });

  it("passes a session-free cookie header through unchanged", () => {
    expect(stripSessionCookie("vscode-tkn=xyz; theme=dark")).toBe("vscode-tkn=xyz; theme=dark");
  });
});

describe("authorizeSpectate (read-only mirror authz)", () => {
  const shared = { workspace: { ownerId: "u-owner", shareEnabled: true } };

  it("forbids everyone when the owner's share flag is off — regardless of role", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-owner", role: "admin" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-owner", shareEnabled: false } });
    expect(await authorizeSpectate(req(), WS, "subscribe")).toEqual({ kind: "forbidden" });
    expect(await authorizeSpectate(req(), WS, "publish")).toEqual({ kind: "forbidden" });
  });

  it("publish is OWNER-only: an admin may not impersonate the mirror stream", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-admin", role: "admin" });
    inspectMock.mockResolvedValue(shared);
    expect(await authorizeSpectate(req(), WS, "publish")).toEqual({ kind: "forbidden" });
    getTokenMock.mockResolvedValue({ uid: "u-owner", role: "developer" });
    expect(await authorizeSpectate(req(), WS, "publish")).toEqual({
      kind: "allow",
      role: "publish",
    });
  });

  it("subscribe admits any signed-in principal WITH a role (viewer floor), and no one without", async () => {
    inspectMock.mockResolvedValue(shared);
    getTokenMock.mockResolvedValue({ uid: "u-someone", role: "viewer" });
    expect(await authorizeSpectate(req(), WS, "subscribe")).toEqual({
      kind: "allow",
      role: "subscribe",
    });
    getTokenMock.mockResolvedValue({ uid: "u-roleless" }); // authenticated but no mapped role
    expect(await authorizeSpectate(req(), WS, "subscribe")).toEqual({ kind: "forbidden" });
    getTokenMock.mockResolvedValue(null); // no session at all
    expect(await authorizeSpectate(req(), WS, "subscribe")).toEqual({ kind: "unauthenticated" });
  });
});
