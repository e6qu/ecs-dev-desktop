// SPDX-License-Identifier: AGPL-3.0-or-later
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import type { ShauthOidcConfig } from "./shauth";
import { verifyShauthBackchannelLogoutToken } from "./shauth";

const config: ShauthOidcConfig = {
  issuer: "https://auth.example.com",
  clientId: "edd",
  clientSecret: "secret",
  postLogoutUrl: "https://edd.example.com/signed-out",
};

async function fixture(claims: Record<string, unknown> = {}, audience = config.clientId) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sid: "provider-session-1",
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(config.issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setJti("logout-1")
    .setExpirationTime(now + 60)
    .sign(privateKey);
  return { token, keys: createLocalJWKSet({ keys: [jwk] }) };
}

describe("verifyShauthBackchannelLogoutToken", () => {
  it("verifies a signed OIDC Back-Channel Logout token and returns its sid", async () => {
    const { token, keys } = await fixture();
    await expect(verifyShauthBackchannelLogoutToken(token, config, keys)).resolves.toBe(
      "provider-session-1",
    );
  });

  it("rejects a token carrying a nonce", async () => {
    const { token, keys } = await fixture({ nonce: "not-allowed" });
    await expect(verifyShauthBackchannelLogoutToken(token, config, keys)).rejects.toThrow(
      "prohibited nonce",
    );
  });

  it("rejects a token for another relying party", async () => {
    const { token, keys } = await fixture({}, "another-client");
    await expect(verifyShauthBackchannelLogoutToken(token, config, keys)).rejects.toThrow();
  });

  it("rejects a token signed by an untrusted key", async () => {
    const { token } = await fixture();
    const { publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    await expect(
      verifyShauthBackchannelLogoutToken(token, config, createLocalJWKSet({ keys: [jwk] })),
    ).rejects.toThrow();
  });
});
