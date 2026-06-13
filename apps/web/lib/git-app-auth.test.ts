// SPDX-License-Identifier: AGPL-3.0-or-later
import { createPublicKey, generateKeyPairSync } from "node:crypto";

import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import {
  listAppInstallations,
  mintInstallationToken,
  signAppJwt,
  type GitHubAppConfig,
} from "./git-app-auth";

// A throwaway RSA keypair (PKCS#1 PEM, like real GitHub App keys / github).
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const verifyKey = createPublicKey(publicKey);

const cfg: GitHubAppConfig = {
  appId: "12345",
  privateKeyPem: privateKey,
  apiBase: "https://api.example.test",
};
const NOW = 1_700_000_000;

describe("signAppJwt", () => {
  it("signs a verifiable RS256 JWT issued by the app id, valid around now", async () => {
    const jwt = await signAppJwt(cfg, NOW);
    const { payload, protectedHeader } = await jwtVerify(jwt, verifyKey, {
      currentDate: new Date(NOW * 1000),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBeLessThanOrEqual(NOW);
    expect(payload.exp).toBeGreaterThan(NOW);
    // GitHub caps app JWTs at 10 minutes.
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(600);
  });

  it("accepts a PKCS#8 key too (createPrivateKey handles both)", async () => {
    const pkcs8 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwt = await signAppJwt({ ...cfg, privateKeyPem: pkcs8.privateKey }, NOW);
    await expect(
      jwtVerify(jwt, createPublicKey(pkcs8.publicKey), { currentDate: new Date(NOW * 1000) }),
    ).resolves.toBeDefined();
  });
});

describe("mintInstallationToken", () => {
  it("POSTs the access_tokens endpoint with the app JWT and returns the token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seenUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return Promise.resolve(
        new Response(
          JSON.stringify({ token: "ghs_installation123", expires_at: "2026-01-01T01:00:00Z" }),
          {
            status: 201,
          },
        ),
      );
    };
    const tok = await mintInstallationToken(cfg, 99, NOW, fetchImpl);
    expect(seenUrl).toBe("https://api.example.test/app/installations/99/access_tokens");
    expect(seenAuth.startsWith("Bearer ")).toBe(true);
    // The bearer is the signed app JWT, verifiable with the app public key.
    await expect(
      jwtVerify(seenAuth.slice("Bearer ".length), verifyKey, { currentDate: new Date(NOW * 1000) }),
    ).resolves.toBeDefined();
    expect(tok.token).toBe("ghs_installation123");
  });

  it("throws on a non-2xx mint response (fails loudly)", async () => {
    const fetchImpl = () => Promise.resolve(new Response("nope", { status: 403 }));
    await expect(mintInstallationToken(cfg, 1, NOW, fetchImpl)).rejects.toThrow(/403/);
  });
});

describe("listAppInstallations", () => {
  it("authenticates with the app JWT and parses installations", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 7,
              target_type: "Organization",
              permissions: { administration: "write" },
              account: { login: "acme", type: "Organization" },
            },
          ]),
          { status: 200 },
        ),
      );
    const installs = await listAppInstallations(cfg, NOW, fetchImpl);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.account?.login).toBe("acme");
    expect(installs[0]?.permissions.administration).toBe("write");
  });
});
