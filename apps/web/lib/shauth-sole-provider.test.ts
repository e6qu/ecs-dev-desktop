// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { shauthEnabled } from "./shauth";

const SHAUTH_ENV = {
  AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev",
  AUTH_SHAUTH_ID: "ecs-dev-desktop-dev",
  AUTH_SHAUTH_SECRET: "secret",
  AUTH_SHAUTH_POST_LOGOUT_URL: "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete",
  AUTH_URL: "https://app.edd.dev.e6qu.dev",
};

// Shauth has already authenticated the person against GitHub, Entra, or a local
// Shauth account before this application ever sees them. Offering a second
// credential path here would ask them to authenticate twice and would leave a
// way into the application that Shauth never saw.
describe("local accounts alongside Shauth", () => {
  it("is the sole browser sign-in path when Shauth is configured", () => {
    expect(shauthEnabled(SHAUTH_ENV)).toBe(true);
  });

  it("leaves local accounts available when Shauth is not configured", () => {
    expect(shauthEnabled({})).toBe(false);
  });

  // A half-configured Shauth must not read as "no Shauth", because that would
  // silently restore the local password form this change removes.
  it("refuses a partial Shauth configuration rather than falling back", () => {
    const { AUTH_SHAUTH_SECRET: _omitted, ...incomplete } = SHAUTH_ENV;
    expect(() => shauthEnabled(incomplete)).toThrow(/must be configured together/);
  });
});
