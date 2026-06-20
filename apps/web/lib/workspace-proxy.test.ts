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
  getTokenMock: vi.fn<() => Promise<{ uid?: string; role?: string } | null>>(),
  inspectMock: vi.fn<() => Promise<{ workspace: { ownerId: string } } | null>>(),
}));
vi.mock("next-auth/jwt", () => ({ getToken: getTokenMock }));
vi.mock("./control-plane", () => ({
  getControlPlane: vi.fn(() => Promise.resolve({ inspect: inspectMock })),
}));

const { authorizeWorkspace, editorTokenRedirect } = await import("./workspace-proxy");

const WS = workspaceId("ws-abc123");
const req = (cookie = "session=x"): CookieBearingRequest => ({ headers: { cookie } });

beforeEach(() => {
  getTokenMock.mockReset();
  inspectMock.mockReset();
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
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "forbidden" });
  });

  it("allows the owner (session uid === workspace ownerId)", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-1" } });
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "allow" });
  });

  it("forbids a different authenticated user", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-2" } });
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "forbidden" });
  });

  it("allows an admin to reach a workspace they do not own", async () => {
    getTokenMock.mockResolvedValue({ uid: "u-1", role: "admin" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-2" } });
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "allow" });
  });

  it("forbids a non-admin whose session carries no subject (fails closed)", async () => {
    getTokenMock.mockResolvedValue({ role: "member" });
    inspectMock.mockResolvedValue({ workspace: { ownerId: "u-1" } });
    expect(await authorizeWorkspace(req(), WS)).toEqual({ kind: "forbidden" });
  });
});

// The connection-token handoff: behind the session-authorizing proxy, the browser's
// initial navigation to the editor is redirected to carry the per-workspace token, so
// the workbench loads without the user ever handling it. Exercises every gate that
// decides whether to inject (secret configured, document nav, no token yet).
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
