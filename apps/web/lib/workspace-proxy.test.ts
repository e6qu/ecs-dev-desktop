// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { authorizeWorkspace } = await import("./workspace-proxy");

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
