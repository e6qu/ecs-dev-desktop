// SPDX-License-Identifier: AGPL-3.0-or-later
// The SSH gateway's connect-time authorize decision: a presented public key is
// allowed onto a workspace iff it is registered to that workspace's owner.
import { createHmac } from "node:crypto";

import { sshAuthorizeResponse } from "@edd/api-contracts";
import { workspacePrincipal } from "@edd/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_SECRET_ENV } from "../../../../../lib/constants";
import {
  apiBase,
  createWorkspaceFor,
  member,
  routeCtx,
  useWorkspaceTable,
} from "../../../../../lib/test-support/workspace-route-harness";
import { POST as registerKey } from "../../../ssh-keys/route";
import { POST as authorize } from "./route";

useWorkspaceTable("ecs-dev-des-web-ssh-authorize-integ");

const TEST_SECRET = "c".repeat(64); // 32 bytes hex
// Distinct registered keys (a public key is globally unique per table).
const KEY_1 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO05tcFAayLhiz/g8pC9LS+JUAFz8sGtKxjB3FUIl2eE owner@a";
const KEY_2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMQvCXtE45nQiyyuHiNRRpiOtXMea4IQSz1JT5L7I8xx owner@b";
const KEY_3 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPrRbd6nXbeqi/zZlhYnFlq00cvMhe9UHQLxhdThG3fq intruder";
const KEY_4_UNREGISTERED =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMbpONUyoZDIwuUSyR9dTM/uE5vedEH4jQQkXN0OPoPJ nobody";

function gatewayToken(wsId: string): string {
  return createHmac("sha256", Buffer.from(TEST_SECRET, "hex")).update(wsId).digest("hex");
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
      headers: member(actor),
      body: JSON.stringify({ publicKey }),
    }),
  );

describe("POST /api/workspaces/:id/ssh-authorize (DynamoDB Local)", () => {
  beforeEach(() => {
    vi.stubEnv(GATEWAY_SECRET_ENV, TEST_SECRET);
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
});
