// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { shauthEnabled, shauthOidcConfig, shauthProvider } from "./shauth";

describe("shauthOidcConfig", () => {
  it("leaves Shauth disabled when it has no coordinates", () => {
    expect(shauthOidcConfig({})).toBeNull();
    expect(shauthEnabled({})).toBe(false);
  });

  it("accepts a complete confidential-client configuration", () => {
    const env = {
      AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev",
      AUTH_SHAUTH_ID: "edd",
      AUTH_SHAUTH_SECRET: "secret",
    };
    expect(shauthOidcConfig(env)).toEqual({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      postLogoutUrl: null,
    });
    expect(shauthEnabled(env)).toBe(true);
  });

  it("rejects incomplete coordinates instead of exposing a broken login", () => {
    expect(() => shauthOidcConfig({ AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev" })).toThrow(
      /must be configured together/,
    );
  });

  it("normalizes secure provider and post-logout coordinates", () => {
    expect(
      shauthOidcConfig({
        AUTH_SHAUTH_ISSUER: " https://auth.dev.e6qu.dev/ ",
        AUTH_SHAUTH_ID: " edd ",
        AUTH_SHAUTH_SECRET: "secret",
        AUTH_SHAUTH_POST_LOGOUT_URL: " https://auth.dev.e6qu.dev/apps ",
      }),
    ).toEqual({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      postLogoutUrl: "https://auth.dev.e6qu.dev/apps",
    });
  });

  it("rejects insecure or ambiguous URLs", () => {
    const base = { AUTH_SHAUTH_ID: "edd", AUTH_SHAUTH_SECRET: "secret" };
    expect(() =>
      shauthOidcConfig({ ...base, AUTH_SHAUTH_ISSUER: "http://auth.example.com" }),
    ).toThrow(/absolute HTTPS URL/);
    expect(() =>
      shauthOidcConfig({
        ...base,
        AUTH_SHAUTH_ISSUER: "https://auth.example.com?issuer=wrong",
      }),
    ).toThrow(/without credentials, query, or fragment/);
    expect(() =>
      shauthOidcConfig({ AUTH_SHAUTH_POST_LOGOUT_URL: "https://auth.example.com/apps" }),
    ).toThrow(/must be configured together/);
  });
});

describe("shauthProvider", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses standard OpenID Connect checks and maps Shauth's exact UserInfo shape", async () => {
    vi.stubEnv("AUTH_SHAUTH_ISSUER", "https://auth.dev.e6qu.dev");
    vi.stubEnv("AUTH_SHAUTH_ID", "edd");
    vi.stubEnv("AUTH_SHAUTH_SECRET", "secret");
    const provider = shauthProvider();
    expect(provider).toMatchObject({
      id: "shauth",
      type: "oidc",
      issuer: "https://auth.dev.e6qu.dev",
      checks: ["pkce", "state", "nonce"],
      authorization: { params: { scope: "openid profile email offline_access" } },
    });
    if (provider === null || typeof provider.profile !== "function") {
      throw new Error("configured Shauth provider has no profile mapper");
    }
    expect(
      await provider.profile({
        sub: "user-1",
        preferred_username: "e6qu",
        email: "e6qu@example.com",
        role: "admin",
      }),
    ).toEqual({
      id: "user-1",
      name: "e6qu",
      email: "e6qu@example.com",
      image: null,
    });
  });
});
