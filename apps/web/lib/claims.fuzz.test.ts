// SPDX-License-Identifier: AGPL-3.0-or-later
// normalizeClaims is the identity edge that feeds role mapping — a parsing slip mislabels who a user
// is. Properties: it produces a complete claim or throws (never a partial), and never silently maps.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeClaims } from "./claims";

describe("normalizeClaims (fuzz)", () => {
  it("github: subject = String(id), groups [] — for any numeric or string id", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string({ minLength: 1 })), (id) => {
        expect(normalizeClaims("github", { id })).toEqual({
          idp: "github",
          subject: String(id),
          groups: [],
        });
      }),
    );
  });

  it("github: a profile without a valid id always throws (never a partial claim)", () => {
    const invalidProfile = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.constant({}),
      fc.record({ id: fc.oneof(fc.boolean(), fc.constant(null), fc.array(fc.integer())) }),
    );
    fc.assert(
      fc.property(invalidProfile, (profile) => {
        expect(() => normalizeClaims("github", profile)).toThrow();
      }),
    );
  });

  it("entra: subject = oid ?? sub, groups default []; both absent throws", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.array(fc.string()), { nil: undefined }),
        (oid, sub, groups) => {
          const profile = {
            ...(oid !== undefined ? { oid } : {}),
            ...(sub !== undefined ? { sub } : {}),
            ...(groups !== undefined ? { groups } : {}),
          };
          if (oid === undefined && sub === undefined) {
            expect(() => normalizeClaims("microsoft-entra-id", profile)).toThrow();
          } else {
            expect(normalizeClaims("microsoft-entra-id", profile)).toEqual({
              idp: "entra",
              subject: oid ?? sub,
              groups: groups ?? [],
            });
          }
        },
      ),
    );
  });

  it("shauth: preserves every non-empty subject and authorized role", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom("developer" as const, "admin" as const),
        (subject, role) => {
          expect(normalizeClaims("shauth", { sub: subject, role })).toEqual({
            idp: "shauth",
            subject,
            groups: [],
            role,
          });
        },
      ),
    );
  });

  it("an unknown provider always throws (never silently maps)", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== "github" && s !== "microsoft-entra-id" && s !== "shauth"),
        (provider) => {
          expect(() => normalizeClaims(provider, { id: 1 })).toThrow();
        },
      ),
    );
  });
});
