// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { shauthEnabled, shauthOidcConfig } from "./shauth";

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
    });
    expect(shauthEnabled(env)).toBe(true);
  });

  it("rejects incomplete coordinates instead of exposing a broken login", () => {
    expect(() => shauthOidcConfig({ AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev" })).toThrow(
      /must be configured together/,
    );
  });
});
