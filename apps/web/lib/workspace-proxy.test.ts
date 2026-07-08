// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { deriveWorkspaceToken, workspaceId } from "@edd/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CookieBearingRequest } from "./workspace-proxy";

// The shell wiring of the in-app `/w/<id>/` proxy authorizer: decode the Auth.js
// session (getToken) + load the workspace (control plane), then defer to the pure
// `decideWorkspaceAccessBySubject` (exhaustively unit-tested in @edd/core). Here we
// pin the GLUE: unauthenticated → redirect to login, unknown ws → forbidden, and
// owner/admin/other map to the right outcome. Both edges are mocked so the test is
// hermetic and controls its own inputs (no DB, no real cookie).
const { getTokenMock, inspectMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn<() => Promise<{ uid?: string; role?: string; exp?: number } | null>>(),
  inspectMock:
    vi.fn<() => Promise<{ workspace: { ownerId: string; shareEnabled?: boolean } } | null>>(),
}));
vi.mock("next-auth/jwt", () => ({ getToken: getTokenMock }));
vi.mock("./control-plane", () => ({
  getControlPlane: vi.fn(() => Promise.resolve({ inspect: inspectMock })),
}));

const {
  authorizeSpectate,
  authorizeWorkspace,
  editorTokenRedirect,
  isDocumentNavigation,
  stripSessionCookie,
} = await import("./workspace-proxy");

const WS = workspaceId("ws-abc123");
const req = (cookie = "session=x"): CookieBearingRequest => ({ headers: { cookie } });

beforeEach(() => {
  getTokenMock.mockReset();
  inspectMock.mockReset();
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
    getTokenMock.mockResolvedValue({ role: "member" });
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

  it("also recognizes the Monaco server's edd-editor-token cookie", () => {
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
    );
    expect(out).toBeUndefined();
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
    getTokenMock.mockResolvedValue({ uid: "u-owner", role: "member" });
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
