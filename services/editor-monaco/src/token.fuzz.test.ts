// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { cookieValue, TOKEN_COOKIE, tokenCookie, tokenFromRequest, tokensMatch } from "./token";

const basePathArb = fc.constantFrom("/w/ws-1/", "/", "/a/b/");

describe("token (fuzz)", () => {
  it("tokenCookie -> cookieValue round-trips ANY token loss-free", () => {
    fc.assert(
      fc.property(fc.string(), basePathArb, (token, basePath) => {
        // The server emits the Set-Cookie; a browser echoes "name=<encoded>" back.
        const pair = tokenCookie(token, basePath).split(";")[0] ?? "";
        expect(cookieValue(pair, TOKEN_COOKIE)).toBe(token);
      }),
    );
  });

  it("tokensMatch is reflexive and equals a byte-equality check (never throws)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(tokensMatch(a, a)).toBe(true);
        expect(tokensMatch(a, b)).toBe(Buffer.from(a).equals(Buffer.from(b)));
      }),
    );
  });

  it("tokenFromRequest prefers a non-empty ?tkn query, else the cookie", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (tkn, cookieTok) => {
          const search = new URLSearchParams(
            tkn === undefined ? "" : `tkn=${encodeURIComponent(tkn)}`,
          );
          const cookieHeader =
            cookieTok === undefined
              ? undefined
              : `${TOKEN_COOKIE}=${encodeURIComponent(cookieTok)}`;
          const result = tokenFromRequest(search, cookieHeader);
          if (tkn !== undefined && tkn !== "") {
            expect(result).toBe(tkn);
          } else {
            expect(result).toBe(cookieTok);
          }
        },
      ),
    );
  });
});
