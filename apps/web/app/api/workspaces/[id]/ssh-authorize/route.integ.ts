// SPDX-License-Identifier: AGPL-3.0-or-later
// The dual-trust connect-time authorize decision: a presented public key is
// allowed onto a workspace iff it is registered to that workspace's owner.
// Both ends call this — the gateway (gateway token) and the workspace sshd (agent
// token) — so coverage exercises both machine credentials.
import { createHmac } from "node:crypto";

import { sshAuthorizeResponse } from "@edd/api-contracts";
import { workspacePrincipal } from "@edd/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_SECRET_ENV, GATEWAY_SECRET_ENV } from "../../../../../lib/constants";
import {
  apiBase,
  createWorkspaceFor,
  developer,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { POST as registerKey } from "../../../ssh-keys/route";
import { POST as authorize } from "./route";

useWorkspaceTable("ecs-dev-des-web-ssh-authorize-integ");

const TEST_SECRET = "c".repeat(64); // 32 bytes hex (gateway)
const AGENT_SECRET = "d".repeat(64); // 32 bytes hex (workspace agent)
// Distinct registered keys (a public key is globally unique per table).
const KEY_1 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO05tcFAayLhiz/g8pC9LS+JUAFz8sGtKxjB3FUIl2eE owner@a";
const KEY_2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMQvCXtE45nQiyyuHiNRRpiOtXMea4IQSz1JT5L7I8xx owner@b";
const KEY_3 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPrRbd6nXbeqi/zZlhYnFlq00cvMhe9UHQLxhdThG3fq intruder";
const KEY_4_UNREGISTERED =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMbpONUyoZDIwuUSyR9dTM/uE5vedEH4jQQkXN0OPoPJ nobody";
const KEY_5 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDXm9BOT8EBmUFLyp//axmOC3Cpg7Y8M/vYegl0+PIbx agent@owner";

function gatewayToken(wsId: string): string {
  return createHmac("sha256", Buffer.from(TEST_SECRET, "hex")).update(wsId).digest("hex");
}

function agentToken(wsId: string): string {
  return createHmac("sha256", Buffer.from(AGENT_SECRET, "hex")).update(wsId).digest("hex");
}

function authorizeReq(id: string, publicKey: string, token?: string): Request {
  return new Request(`${apiBase}/${id}/ssh-authorize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token ?? gatewayToken(id)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ publicKey }),
  });
}

const registerFor = (actor: string, publicKey: string): Promise<Response> =>
  registerKey(
    new Request("http://localhost/api/ssh-keys", {
      method: "POST",
      headers: developer(actor),
      body: JSON.stringify({ publicKey }),
    }),
  );

describe("POST /api/workspaces/:id/ssh-authorize (DynamoDB Local)", () => {
  beforeEach(() => {
    vi.stubEnv(GATEWAY_SECRET_ENV, TEST_SECRET);
    vi.stubEnv(AGENT_SECRET_ENV, AGENT_SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("authorizes the owner's registered key and returns the workspace principal", async () => {
    const id = await createWorkspaceFor("owner");
    expect((await registerFor("owner", KEY_1)).status).toBe(201);

    const res = await authorize(authorizeReq(id, KEY_1), routeCtx(id));
    expect(res.status).toBe(200);
    const body = sshAuthorizeResponse.parse(await res.json());
    expect(body.authorized).toBe(true);
    expect(body.principal).toBe(workspacePrincipal(id));
  });

  it("also accepts the workspace agent token (inner-hop AuthorizedKeysCommand)", async () => {
    const id = await createWorkspaceFor("agent-owner");
    expect((await registerFor("agent-owner", KEY_5)).status).toBe(201);

    const res = await authorize(authorizeReq(id, KEY_5, agentToken(id)), routeCtx(id));
    expect(res.status).toBe(200);
    expect(sshAuthorizeResponse.parse(await res.json()).authorized).toBe(true);
  });

  it("denies a key registered to a different user (ownership mismatch)", async () => {
    const id = await createWorkspaceFor("owner2");
    expect((await registerFor("owner2", KEY_2)).status).toBe(201);
    expect((await registerFor("intruder", KEY_3)).status).toBe(201);

    const body = sshAuthorizeResponse.parse(
      await (await authorize(authorizeReq(id, KEY_3), routeCtx(id))).json(),
    );
    expect(body.authorized).toBe(false);
    expect(body.principal).toBeUndefined();
  });

  it("denies an unregistered key", async () => {
    const id = await createWorkspaceFor("owner3");
    const body = sshAuthorizeResponse.parse(
      await (await authorize(authorizeReq(id, KEY_4_UNREGISTERED), routeCtx(id))).json(),
    );
    expect(body.authorized).toBe(false);
  });

  it("rejects a request without a valid gateway token (401)", async () => {
    const id = await createWorkspaceFor("owner4");
    const res = await authorize(authorizeReq(id, KEY_1, "deadbeef"), routeCtx(id));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed JSON body with 400, not a 500", async () => {
    const id = await createWorkspaceFor("owner5");
    const res = await authorize(
      new Request(`${apiBase}/${id}/ssh-authorize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayToken(id)}`,
          "content-type": "application/json",
        },
        body: "{ not json",
      }),
      routeCtx(id),
    );
    expect(res.status).toBe(400);
  });
});
