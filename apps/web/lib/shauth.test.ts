// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { shauthEnabled, shauthEndSessionURL, shauthOidcConfig, shauthProvider } from "./shauth";

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
      AUTH_SHAUTH_POST_LOGOUT_URL: "https://app.edd.dev.e6qu.dev/signed-out",
      AUTH_URL: "https://app.edd.dev.e6qu.dev",
    };
    expect(shauthOidcConfig(env)).toEqual({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      postLogoutUrl: "https://app.edd.dev.e6qu.dev/signed-out",
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
        AUTH_SHAUTH_POST_LOGOUT_URL: " https://app.edd.dev.e6qu.dev/signed-out ",
        AUTH_URL: " https://app.edd.dev.e6qu.dev/ ",
      }),
    ).toEqual({
      issuer: "https://auth.dev.e6qu.dev",
      clientId: "edd",
      clientSecret: "secret",
      postLogoutUrl: "https://app.edd.dev.e6qu.dev/signed-out",
    });
  });

  it("rejects a provider-origin post-logout URL that Hydra cannot accept", () => {
    expect(() =>
      shauthOidcConfig({
        AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev",
        AUTH_SHAUTH_ID: "edd",
        AUTH_SHAUTH_SECRET: "secret",
        AUTH_SHAUTH_POST_LOGOUT_URL: "https://auth.dev.e6qu.dev/apps",
        AUTH_URL: "https://app.edd.dev.e6qu.dev",
      }),
    ).toThrow(/same origin/);
  });

  it("requires the stable Auth.js origin when Shauth is configured", () => {
    expect(() =>
      shauthOidcConfig({
        AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev",
        AUTH_SHAUTH_ID: "edd",
        AUTH_SHAUTH_SECRET: "secret",
        AUTH_SHAUTH_POST_LOGOUT_URL: "https://app.edd.dev.e6qu.dev/signed-out",
      }),
    ).toThrow(/AUTH_URL is required/);
  });

  it("rejects insecure or ambiguous URLs", () => {
    const base = {
      AUTH_SHAUTH_ID: "edd",
      AUTH_SHAUTH_SECRET: "secret",
      AUTH_SHAUTH_POST_LOGOUT_URL: "https://app.example.com/signed-out",
      AUTH_URL: "https://app.example.com",
    };
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
    vi.stubEnv("AUTH_SHAUTH_POST_LOGOUT_URL", "https://edd.example.com/signed-out");
    vi.stubEnv("AUTH_URL", "https://edd.example.com");
    const provider = shauthProvider();
    expect(provider).toMatchObject({
      id: "shauth",
      type: "oidc",
      issuer: "https://auth.dev.e6qu.dev",
      client: { token_endpoint_auth_method: "client_secret_post" },
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

describe("shauthEndSessionURL", () => {
  it("creates the provider's RP-Initiated Logout URL with exact registered redirect", () => {
    const result = new URL(
      shauthEndSessionURL(
        {
          issuer: "https://auth.dev.e6qu.dev",
          clientId: "edd",
          clientSecret: "secret",
          postLogoutUrl: "https://app.edd.dev.e6qu.dev/signed-out",
        },
        "header.payload.signature",
      ),
    );
    expect(result.origin + result.pathname).toBe(
      "https://auth.dev.e6qu.dev/oauth2/sessions/logout",
    );
    expect(result.searchParams.get("id_token_hint")).toBe("header.payload.signature");
    expect(result.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.edd.dev.e6qu.dev/signed-out",
    );
  });
});
