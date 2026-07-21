// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const configured = {
  AUTH_SHAUTH_ISSUER: "https://auth.dev.e6qu.dev",
  AUTH_SHAUTH_ID: "edd",
  AUTH_SHAUTH_SECRET: "secret",
  AUTH_SHAUTH_POST_LOGOUT_URL: "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete",
  AUTH_URL: "https://app.edd.dev.e6qu.dev",
} as const;

describe("GET /auth/shauth/logout/complete", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns only to the issuer-derived Shauth completion endpoint", () => {
    for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);

    const response = GET(new Request("https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auth.dev.e6qu.dev/oauth/logout/complete",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("cannot be influenced by query, fragment, redirect, or replay input", () => {
    for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);

    const first = GET(
      new Request(
        "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete?post_logout_redirect_uri=https%3A%2F%2Fattacker.invalid%2F&return_to=%2Fadmin#ignored",
      ),
    );
    const replay = GET(
      new Request(
        "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete?destination=https%3A%2F%2Fattacker.invalid%2F",
      ),
    );

    expect(first.headers.get("location")).toBe("https://auth.dev.e6qu.dev/oauth/logout/complete");
    expect(replay.headers.get("location")).toBe(first.headers.get("location"));
  });

  it("is unavailable when Shauth is not configured", () => {
    const response = GET(new Request("https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete"));

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});
