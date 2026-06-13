// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import { baseImage, ownerId } from "@edd/core";
import { agentToken } from "@edd/compute-ecs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGENT_SECRET_ENV } from "../../../../../lib/constants";
import { getControlPlane } from "../../../../../lib/control-plane";
import { getGitCredentials } from "../../../../../lib/git-credentials";
import { useWorkspaceTable } from "../../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * The boot-time git credential broker against DynamoDB Local: a stored token is
 * returned only to the workspace's own agent (HMAC machine-auth), encrypted at
 * rest in between. Every other caller (no token, wrong token, no credential) is
 * refused.
 */
const AGENT_SECRET = randomBytes(32).toString("hex");
const TOKEN = "ghp_exampleSessionToken_not_real_001";

useWorkspaceTable("edd-gitcred-integ");

let ownerWsId: string;
let otherWsId: string;

beforeAll(async () => {
  process.env.EDD_TOKEN_ENC_KEY = randomBytes(32).toString("hex");
  process.env[AGENT_SECRET_ENV] = AGENT_SECRET;

  const cp = await getControlPlane();
  const owned = await cp.create({
    ownerId: ownerId("git-owner"),
    baseImage: baseImage("golden/node:20"),
  });
  ownerWsId = owned.id;
  const other = await cp.create({
    ownerId: ownerId("no-cred-owner"),
    baseImage: baseImage("golden/node:20"),
  });
  otherWsId = other.id;

  // The owner has a stored git credential; the "other" owner does not.
  await getGitCredentials().store("git-owner", TOKEN);
});

afterAll(() => {
  // Empty string ⇒ treated as unset by the machine-auth + credential code.
  process.env.EDD_TOKEN_ENC_KEY = "";
  process.env[AGENT_SECRET_ENV] = "";
});

function brokerRequest(wsId: string, bearer: string | undefined): Request {
  const headers = new Headers();
  if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`http://localhost/api/workspaces/${wsId}/git-credential`, { headers });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("git credential broker", () => {
  it("returns the decrypted token to the workspace's own agent", async () => {
    const token = agentToken(AGENT_SECRET, ownerWsId);
    const res = await GET(brokerRequest(ownerWsId, token), ctx(ownerWsId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string; token: string };
    expect(body.token).toBe(TOKEN);
    expect(body.username).toBe("x-access-token");
  });

  it("refuses a request with no agent token (401)", async () => {
    const res = await GET(brokerRequest(ownerWsId, undefined), ctx(ownerWsId));
    expect(res.status).toBe(401);
  });

  it("refuses a token minted for a different workspace (401, per-workspace HMAC)", async () => {
    const wrong = agentToken(AGENT_SECRET, otherWsId); // valid for otherWsId, not ownerWsId
    const res = await GET(brokerRequest(ownerWsId, wrong), ctx(ownerWsId));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the owner has no stored credential", async () => {
    const token = agentToken(AGENT_SECRET, otherWsId);
    const res = await GET(brokerRequest(otherWsId, token), ctx(otherWsId));
    expect(res.status).toBe(404);
  });
});
