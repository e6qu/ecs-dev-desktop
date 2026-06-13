// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

import { POMERIUM_ASSERTION_HEADER, WORKSPACE_HOST_HEADER } from "@edd/config";
import { baseImage, email, ownerId } from "@edd/core";
import { assertionFromEcho, authedGet, pomeriumRequest, ROUTE_DOMAIN } from "@edd/e2e/pomerium";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getControlPlane } from "../../../../lib/control-plane";
import { useWorkspaceTable } from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * End-to-end per-workspace authorization (DO_NEXT #5) against the REAL Pomerium
 * proxy + azure-sim (docker-compose.e2e.yml) and DynamoDB Local.
 *
 * The novel proof here, beyond the unit/integration tests (which mint their own
 * tokens): a genuine Pomerium v0.32.2 assertion — driven through the full OIDC
 * flow — is verified by the actual PDP route against Pomerium's real JWKS, and
 * the ownership decision against real workspace records is correct. We drive the
 * flow to capture real assertions, seed workspaces with matching/mismatching
 * owner emails, then assert: the owner is allowed (204), a different
 * authenticated user is denied (403), a token replayed at a different workspace
 * is rejected (401, aud is bound to the host), and a missing token is 401.
 *
 * The JWKS is fetched from Pomerium over its trusted-CA TLS listener and relayed
 * over plain loopback HTTP (the public keys are Pomerium's; only the transport
 * is local — it keeps this in-process verifier from needing the CA bootstrapped
 * at startup). Endpoint-only per §6.8.
 */

const IMAGE = "golden/node:20";

useWorkspaceTable("edd-authz-pdp-e2e");

let jwksServer: Server;
let ownerHost: string;
let otherHost: string;
let ownerAssertion: string;
let otherAssertion: string;

/** Fetch the value an assertion must carry by completing the OIDC flow to `host`. */
async function assertionFor(host: string): Promise<string> {
  const { hop } = await authedGet(host);
  expect(hop.status, `expected 200 from authenticated ${host}`).toBe(200);
  const token = assertionFromEcho(hop.body);
  if (token === undefined) throw new Error(`no X-Pomerium-Jwt-Assertion echoed for ${host}`);
  return token;
}

beforeAll(async () => {
  // Relay Pomerium's real JWKS over loopback HTTP for the in-process verifier.
  const jwks = await pomeriumRequest(
    new URL(`https://health.${ROUTE_DOMAIN}/.well-known/pomerium/jwks.json`),
  );
  expect(jwks.status, "Pomerium JWKS endpoint should return 200").toBe(200);
  expect(jwks.body, "JWKS body should contain keys").toMatch(/"keys"/);
  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(jwks.body);
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const port = (jwksServer.address() as AddressInfo).port;
  process.env.EDD_POMERIUM_JWKS_URL = `http://127.0.0.1:${String(port)}/jwks`;

  // Learn the authenticated sim user's email from a throwaway assertion.
  const probe = await assertionFor(`ws-probe.${ROUTE_DOMAIN}`);
  const simEmail = decodeJwt(probe).email;
  if (typeof simEmail !== "string") {
    throw new Error("the Pomerium assertion must carry an email claim");
  }

  // Seed two workspaces: one owned by the sim user, one by someone else.
  const cp = await getControlPlane();
  const owned = await cp.create({
    ownerId: ownerId("u-owner"),
    ownerEmail: email(simEmail),
    baseImage: baseImage(IMAGE),
  });
  ownerHost = `${owned.id}.${ROUTE_DOMAIN}`;
  const other = await cp.create({
    ownerId: ownerId("u-other"),
    ownerEmail: email("intruder@edd.test"),
    baseImage: baseImage(IMAGE),
  });
  otherHost = `${other.id}.${ROUTE_DOMAIN}`;

  // Real Pomerium assertions bound (aud) to each workspace host.
  ownerAssertion = await assertionFor(ownerHost);
  otherAssertion = await assertionFor(otherHost);
}, 120_000);

afterAll(() => {
  jwksServer.closeAllConnections();
  jwksServer.close();
});

function authzRequest(host: string, token: string | undefined): Request {
  const headers = new Headers({ [WORKSPACE_HOST_HEADER]: host });
  if (token !== undefined) headers.set(POMERIUM_ASSERTION_HEADER, token);
  return new Request("http://localhost/api/internal/authz", { headers });
}

describe("per-workspace proxy authorization with a real Pomerium assertion", () => {
  it("allows the owner (real assertion verified against Pomerium's JWKS) → 204", async () => {
    const res = await GET(authzRequest(ownerHost, ownerAssertion));
    expect(res.status).toBe(204);
  });

  it("denies a different authenticated user on a workspace they do not own → 403", async () => {
    const res = await GET(authzRequest(otherHost, otherAssertion));
    expect(res.status).toBe(403);
  });

  it("rejects a real assertion replayed at a different workspace host → 401", async () => {
    // ownerAssertion's aud is ownerHost; aiming it at otherHost fails aud check.
    const res = await GET(authzRequest(otherHost, ownerAssertion));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no assertion → 401", async () => {
    const res = await GET(authzRequest(ownerHost, undefined));
    expect(res.status).toBe(401);
  });
});
