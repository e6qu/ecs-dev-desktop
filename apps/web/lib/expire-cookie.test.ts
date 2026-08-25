// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { expireCookie, type ExpirableCookieStore } from "./expire-cookie";

function recorder(): { store: ExpirableCookieStore; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    store: {
      set(options) {
        calls.push({ ...options });
      },
    },
    calls,
  };
}

describe("expireCookie", () => {
  it("expires a __Secure- cookie WITH the Secure attribute — the browser rejects the deletion without it", () => {
    const { store, calls } = recorder();
    expireCookie(store, "__Secure-authjs.session-token");
    expect(calls).toEqual([
      {
        name: "__Secure-authjs.session-token",
        value: "",
        path: "/",
        expires: new Date(0),
        secure: true,
      },
    ]);
  });

  it("expires a __Host- cookie with Secure and Path=/ (both required by the prefix)", () => {
    const { store, calls } = recorder();
    expireCookie(store, "__Host-authjs.csrf-token");
    expect(calls[0]).toMatchObject({ secure: true, path: "/" });
    expect(calls[0]).not.toHaveProperty("domain");
  });

  it("expires an unprefixed cookie without forcing Secure (dev over http must still work)", () => {
    const { store, calls } = recorder();
    expireCookie(store, "authjs.session-token");
    expect(calls[0]).toMatchObject({ name: "authjs.session-token", value: "", path: "/" });
    expect(calls[0]).not.toHaveProperty("secure");
  });
});
