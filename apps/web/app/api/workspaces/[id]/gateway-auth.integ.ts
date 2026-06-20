// SPDX-License-Identifier: AGPL-3.0-or-later
// Machine-auth coverage for the SSH gateway's wake-on-connect path: the gateway
// holds EDD_GATEWAY_SECRET and calls POST /connect, GET /:id, GET /connect-info
// with a per-workspace HMAC bearer token (`wake-and-forward.sh`). These tests
// prove the real control plane accepts that credential — and nothing weaker.
import { createHmac } from "node:crypto";

import { workspace } from "@edd/api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_SECRET_ENV } from "../../../../lib/constants";
import {
  apiBase,
  createWorkspaceFor,
  postLifecycle,
  routeCtx,
  useWorkspaceTable,
} from "../../../../lib/test-support/workspace-route-harness";
import { POST as connect } from "./connect/route";
import { GET as connectInfo } from "./connect-info/route";
import { POST as stop } from "./stop/route";
import { GET as get, DELETE as del } from "./route";

useWorkspaceTable("ecs-dev-des-web-gateway-auth-integ");

const TEST_SECRET = "b".repeat(64); // 32 bytes hex

function gatewayToken(wsId: string): string {
  return createHmac("sha256", Buffer.from(TEST_SECRET, "hex")).update(wsId).digest("hex");
}

function asGateway(id: string, path: string, method: string, token?: string): Request {
  return new Request(`${apiBase}/${id}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token ?? gatewayToken(id)}` },
  });
}

describe("SSH gateway machine-auth on the wake-on-connect routes (DynamoDB Local)", () => {
  beforeEach(() => {
    vi.stubEnv(GATEWAY_SECRET_ENV, TEST_SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gateway token wakes a stopped workspace via POST /connect (200)", async () => {
    const id = await createWorkspaceFor("gw-user-1");
    expect((await postLifecycle(stop, "stop", "gw-user-1", id)).status).toBe(200);

    const res = await connect(asGateway(id, "/connect", "POST"), routeCtx(id));
    expect(res.status).toBe(200);
    expect(workspace.parse(await res.json()).state).toBe("running");
  });

  it("gateway token can poll workspace state via GET /:id (200)", async () => {
    const id = await createWorkspaceFor("gw-user-2");
    const res = await get(asGateway(id, "", "GET"), routeCtx(id));
    expect(res.status).toBe(200);
    expect(workspace.parse(await res.json()).id).toBe(id);
  });

  it("gateway token can read connect-info for a running workspace", async () => {
    const id = await createWorkspaceFor("gw-user-3");
    const res = await connectInfo(asGateway(id, "/connect-info", "GET"), routeCtx(id));
    // FakeComputeProvider sets no sshHost → 409 (host not yet assigned, retry-able); the
    // route still AUTHENTICATED the gateway (otherwise it would be 401, not 409).
    expect(res.status).toBe(409);
  });

  it("rejects a wrong gateway token with 401 on all three routes", async () => {
    const id = await createWorkspaceFor("gw-user-4");
    expect((await connect(asGateway(id, "/connect", "POST", "f00d"), routeCtx(id))).status).toBe(
      401,
    );
    expect((await get(asGateway(id, "", "GET", "f00d"), routeCtx(id))).status).toBe(401);
    expect(
      (await connectInfo(asGateway(id, "/connect-info", "GET", "f00d"), routeCtx(id))).status,
    ).toBe(401);
  });

  it("rejects a token minted for a different workspace (401)", async () => {
    const idA = await createWorkspaceFor("gw-user-5");
    const idB = await createWorkspaceFor("gw-user-6");
    const res = await connect(asGateway(idA, "/connect", "POST", gatewayToken(idB)), routeCtx(idA));
    expect(res.status).toBe(401);
  });

  it("rejects gateway tokens when EDD_GATEWAY_SECRET is unset (401)", async () => {
    vi.stubEnv(GATEWAY_SECRET_ENV, "");
    const id = await createWorkspaceFor("gw-user-7");
    expect((await connect(asGateway(id, "/connect", "POST"), routeCtx(id))).status).toBe(401);
  });

  it("returns 404 for an unknown workspace id with a valid-format token", async () => {
    const res = await connect(asGateway("ws-nope", "/connect", "POST"), routeCtx("ws-nope"));
    expect(res.status).toBe(404);
  });

  it("does NOT grant the gateway token access to destructive routes (DELETE stays session-only)", async () => {
    const id = await createWorkspaceFor("gw-user-8");
    const res = await del(asGateway(id, "", "DELETE"), routeCtx(id));
    expect(res.status).toBe(401);
  });
});
