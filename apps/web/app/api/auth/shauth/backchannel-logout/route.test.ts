// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const endpoint = "https://app.edd.dev.e6qu.dev/api/auth/shauth/backchannel-logout";

describe("POST /api/auth/shauth/backchannel-logout", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SHAUTH_ISSUER", "https://auth.dev.e6qu.dev");
    vi.stubEnv("AUTH_SHAUTH_ID", "edd");
    vi.stubEnv("AUTH_SHAUTH_SECRET", "secret");
    vi.stubEnv(
      "AUTH_SHAUTH_POST_LOGOUT_URL",
      "https://app.edd.dev.e6qu.dev/auth/shauth/logout/complete",
    );
    vi.stubEnv("AUTH_URL", "https://app.edd.dev.e6qu.dev");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects a duplicate logout-token field before verification", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "logout_token=one&logout_token=two",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("single logout_token");
  });

  it("streams and rejects an undeclared oversized body without buffering it all", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `logout_token=${"a".repeat(20 * 1024)}`,
      }),
    );

    expect(response.status).toBe(413);
  });

  it("rejects a non-form request", async () => {
    const response = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logout_token: "value" }),
      }),
    );

    expect(response.status).toBe(415);
  });
});
