// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { cookieValue, TOKEN_COOKIE, tokenFromRequest, tokensMatch } from "./token";

describe("tokensMatch", () => {
  it("matches identical tokens and rejects different ones (incl. length)", () => {
    expect(tokensMatch("abc123def456", "abc123def456")).toBe(true);
    expect(tokensMatch("abc123def456", "abc123def457")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
  });
});

describe("cookieValue", () => {
  it("extracts a named cookie from a Cookie header", () => {
    expect(cookieValue(`a=1; ${TOKEN_COOKIE}=tok123; b=2`, TOKEN_COOKIE)).toBe("tok123");
    expect(cookieValue("a=1", TOKEN_COOKIE)).toBeUndefined();
    expect(cookieValue(undefined, TOKEN_COOKIE)).toBeUndefined();
  });
});

describe("tokenFromRequest", () => {
  it("prefers the ?tkn query, falls back to the cookie, else undefined", () => {
    expect(tokenFromRequest(new URLSearchParams("tkn=Q"), `${TOKEN_COOKIE}=C`)).toBe("Q");
    expect(tokenFromRequest(new URLSearchParams(""), `${TOKEN_COOKIE}=C`)).toBe("C");
    expect(tokenFromRequest(new URLSearchParams(""), undefined)).toBeUndefined();
  });
});
