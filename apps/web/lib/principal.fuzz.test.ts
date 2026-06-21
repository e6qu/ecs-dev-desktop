// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { cookieValue } from "./principal";

// `cookieValue` parses a value out of an attacker-supplied `Cookie:` header, so it
// must be total: never throw on a malformed header (missing `=`, duplicate names,
// URL-encoded, empty), and return the right value or undefined.

const cookieName = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/);

describe("cookieValue (property)", () => {
  it("never throws on arbitrary cookie headers", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.string()), cookieName, (header, name) => {
        expect(() => cookieValue(header, name)).not.toThrow();
      }),
    );
  });

  it("returns undefined for a header that does not contain the name", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(cookieName, fc.string({ minLength: 1 })), { maxLength: 10 }),
        cookieName,
        (pairs, target) => {
          fc.pre(pairs.every(([n]) => n !== target));
          const header = pairs.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
          expect(cookieValue(header, target)).toBeUndefined();
        },
      ),
    );
  });

  it("returns the URL-decoded value of a present cookie", () => {
    fc.assert(
      fc.property(cookieName, fc.string(), (name, value) => {
        const header = `${name}=${encodeURIComponent(value)}`;
        expect(cookieValue(header, name)).toBe(value);
      }),
    );
  });

  it("returns the FIRST occurrence when a name is duplicated", () => {
    fc.assert(
      fc.property(
        cookieName,
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (name, first, second) => {
          const header = `${name}=${encodeURIComponent(first)}; ${name}=${encodeURIComponent(second)}`;
          expect(cookieValue(header, name)).toBe(first);
        },
      ),
    );
  });
});
