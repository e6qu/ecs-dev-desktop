// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import { workspaceGitSshKeysResponse } from "@edd/api-contracts";
import { agentToken } from "@edd/compute-ecs";
import { baseImage, ownerId, workspaceId } from "@edd/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGENT_SECRET_ENV } from "../../../../../lib/constants";
import { getControlPlane } from "../../../../../lib/control-plane";
import { getGitSshKeys } from "../../../../../lib/git-credentials";
import { useWorkspaceTable } from "../../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * The boot-time git SSH key broker against DynamoDB Local: the owner's generated keys,
 * private halves included, go only to the workspace's own agent (HMAC machine-auth).
 * Every other caller is refused; an owner with no keys gets an empty 204; a workspace
 * being torn down gets nothing.
 */
const AGENT_SECRET = randomBytes(32).toString("hex");

useWorkspaceTable("edd-gitsshkeys-integ");

let ownerWsId: string;
let otherWsId: string;

beforeAll(async () => {
  process.env.EDD_TOKEN_ENC_KEY = randomBytes(32).toString("hex");
  process.env[AGENT_SECRET_ENV] = AGENT_SECRET;
  // Point the host-key lookup at nothing routable, so the broker's known_hosts is empty
  // here (the workspace then trusts on first use) and the test does not touch the network.
  process.env.AUTH_GITHUB_API_URL = "https://127.0.0.1:1";
  const cp = await getControlPlane();
  ownerWsId = (
    await cp.create({ ownerId: ownerId("key-owner"), baseImage: baseImage("golden/node:20") })
  ).id;
  otherWsId = (
    await cp.create({ ownerId: ownerId("keyless-owner"), baseImage: baseImage("golden/node:20") })
  ).id;
  await getGitSshKeys().generate(ownerId("key-owner"), "laptop");
  await getGitSshKeys().generate(ownerId("key-owner"), "deploy key for app");
});

afterAll(() => {
  process.env.EDD_TOKEN_ENC_KEY = "";
  process.env[AGENT_SECRET_ENV] = "";
  delete process.env.AUTH_GITHUB_API_URL;
});

function brokerRequest(wsId: string, bearer: string | undefined): Request {
  const headers = new Headers();
  if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`http://localhost/api/workspaces/${wsId}/git-ssh-keys`, { headers });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/workspaces/:id/git-ssh-keys (agent broker)", () => {
  it("delivers the owner's keys, private halves included, to the workspace's own agent", async () => {
    const res = await GET(
      brokerRequest(ownerWsId, agentToken(AGENT_SECRET, ownerWsId)),
      ctx(ownerWsId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = workspaceGitSshKeysResponse.parse(await res.json());
    expect(body.host).toBe("github.com");
    expect(body.knownHosts).toEqual([]);
    expect(body.keys.map((k) => k.label)).toEqual(["deploy key for app", "laptop"]);
    for (const key of body.keys) {
      expect(key.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
      expect(key.publicKey).toMatch(/^ssh-ed25519 /);
    }
  });

  it("refuses a missing or foreign agent token (401)", async () => {
    expect((await GET(brokerRequest(ownerWsId, undefined), ctx(ownerWsId))).status).toBe(401);
    const foreign = agentToken(AGENT_SECRET, otherWsId);
    expect((await GET(brokerRequest(ownerWsId, foreign), ctx(ownerWsId))).status).toBe(401);
  });

  it("answers 204 (no content, not an error) when the owner has no keys", async () => {
    const res = await GET(
      brokerRequest(otherWsId, agentToken(AGENT_SECRET, otherWsId)),
      ctx(otherWsId),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("delivers nothing to a workspace being torn down", async () => {
    const cp = await getControlPlane();
    const doomed = await cp.create({
      ownerId: ownerId("key-owner"),
      baseImage: baseImage("golden/node:20"),
    });
    await cp.remove(workspaceId(doomed.id));
    const res = await GET(
      brokerRequest(doomed.id, agentToken(AGENT_SECRET, doomed.id)),
      ctx(doomed.id),
    );
    expect(res.status).toBe(404);
  });
});
