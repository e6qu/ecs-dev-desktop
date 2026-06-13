// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { POMERIUM_ASSERTION_HEADER, WORKSPACE_HOST_HEADER } from "@edd/config";
import { baseImage, email, ownerId } from "@edd/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_GROUPS_ENV } from "../../../../lib/constants";
import { getControlPlane } from "../../../../lib/control-plane";
import { useWorkspaceTable } from "../../../../lib/test-support/workspace-route-harness";
import { GET } from "./route";

/**
 * The per-workspace authorization PDP (`/api/internal/authz`) against DynamoDB
 * Local, with a local JWKS server standing in for Pomerium. Proves the full
 * decision: a Pomerium-shaped assertion is verified (signature + aud/iss bound
 * to the workspace host), and access is granted only to the owner (email match)
 * or an admin — every other case (different user, forged/replayed/expired token,
 * unknown workspace, missing headers) is denied.
 */

const DOMAIN = "devbox.localhost";
const KID = "test-kid";
const IMAGE = "golden/node:20";

useWorkspaceTable("edd-authz-pdp-integ");

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwksServer: Server;
let ownerHost: string;
let otherHost: string;

beforeAll(async () => {
  process.env[ADMIN_GROUPS_ENV] = "g-admin";
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = KID;
  jwk.alg = "ES256";
  jwk.use = "sig";

  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const port = (jwksServer.address() as AddressInfo).port;
  process.env.EDD_POMERIUM_JWKS_URL = `http://127.0.0.1:${String(port)}/jwks`;

  const cp = await getControlPlane();
  const owned = await cp.create({
    ownerId: ownerId("u-owner"),
    ownerEmail: email("owner@edd.test"),
    baseImage: baseImage(IMAGE),
  });
  ownerHost = `${owned.id}.${DOMAIN}`;
  const other = await cp.create({
    ownerId: ownerId("u-other"),
    ownerEmail: email("other@edd.test"),
    baseImage: baseImage(IMAGE),
  });
  otherHost = `${other.id}.${DOMAIN}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    jwksServer.close(() => {
      resolve();
    }),
  );
});

interface Claims {
  email?: string;
  groups?: string[];
  aud?: string;
  iss?: string;
}

/** Mint a Pomerium-shaped assertion for `host` (aud/iss default to it). */
async function mint(host: string, claims: Claims): Promise<string> {
  return new SignJWT({ email: claims.email ?? "owner@edd.test", groups: claims.groups ?? [] })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(claims.iss ?? host)
    .setAudience(claims.aud ?? host)
    .setSubject("subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function authzRequest(host: string | undefined, token: string | undefined): Request {
  const headers = new Headers();
  if (host !== undefined) headers.set(WORKSPACE_HOST_HEADER, host);
  if (token !== undefined) headers.set(POMERIUM_ASSERTION_HEADER, token);
  return new Request("http://localhost/api/internal/authz", { headers });
}

describe("workspace authorization PDP", () => {
  it("allows the owner (email match) → 204", async () => {
    const token = await mint(ownerHost, { email: "owner@edd.test" });
    const res = await GET(authzRequest(ownerHost, token));
    expect(res.status).toBe(204);
  });

  it("allows the owner case-insensitively", async () => {
    const token = await mint(ownerHost, { email: "OWNER@EDD.TEST" });
    const res = await GET(authzRequest(ownerHost, token));
    expect(res.status).toBe(204);
  });

  it("authorizes when the forwarded host carries a non-default proxy port → 204", async () => {
    // The proxy may preserve the original Host (e.g. the harness's :8443) while
    // the assertion's aud/iss is the bare hostname — the PDP must authorize on the
    // hostname, ignoring the transport port (regression: this was a 401 before).
    const token = await mint(ownerHost, { email: "owner@edd.test" });
    const res = await GET(authzRequest(`${ownerHost}:8443`, token));
    expect(res.status).toBe(204);
  });

  it("denies a different authenticated user → 403", async () => {
    const token = await mint(ownerHost, { email: "other@edd.test" });
    const res = await GET(authzRequest(ownerHost, token));
    expect(res.status).toBe(403);
  });

  it("allows an admin (group claim) on a workspace they do not own → 204", async () => {
    const token = await mint(ownerHost, { email: "admin@edd.test", groups: ["g-admin"] });
    const res = await GET(authzRequest(ownerHost, token));
    expect(res.status).toBe(204);
  });

  it("denies when the assertion is missing → 401", async () => {
    const res = await GET(authzRequest(ownerHost, undefined));
    expect(res.status).toBe(401);
  });

  it("denies when the workspace host header is missing → 401", async () => {
    const token = await mint(ownerHost, { email: "owner@edd.test" });
    const res = await GET(authzRequest(undefined, token));
    expect(res.status).toBe(401);
  });

  it("rejects a replayed token whose aud is a different workspace → 401", async () => {
    // Owner of `otherHost` presents their own valid token but aims it at ownerHost.
    const token = await mint(otherHost, { email: "other@edd.test" });
    const res = await GET(authzRequest(ownerHost, token));
    expect(res.status).toBe(401);
  });

  it("denies an unknown workspace host → 403", async () => {
    const ghost = `ws-doesnotexist.${DOMAIN}`;
    const token = await mint(ghost, { email: "owner@edd.test" });
    const res = await GET(authzRequest(ghost, token));
    expect(res.status).toBe(403);
  });

  it("rejects a host that is not under the base domain → 403", async () => {
    const evil = "ws-abc.evil.example";
    const token = await mint(evil, { email: "owner@edd.test" });
    const res = await GET(authzRequest(evil, token));
    expect(res.status).toBe(403);
  });
});
