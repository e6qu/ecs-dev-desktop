// SPDX-License-Identifier: AGPL-3.0-or-later
// matchDevUser is the dev-auth credential gate; the exact-username + password
// equality boundary and first-match semantics are exactly what example tests under-explore.
import type { DevUser } from "@edd/config";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { matchDevUser } from "./dev-users";

const userArb: fc.Arbitrary<DevUser> = fc.record({
  username: fc.string(),
  role: fc.constantFrom("admin", "member", "viewer"),
  email: fc.string(),
  password: fc.string(),
});

describe("matchDevUser (fuzz)", () => {
  it("matches iff exact username AND password match the first same-username account", () => {
    fc.assert(
      fc.property(fc.array(userArb), fc.string(), fc.string(), (users, username, password) => {
        const result = matchDevUser(users, username, password);
        const first = users.find((u) => u.username === username); // the FIRST same-username record
        if (first === undefined) {
          expect(result).toBeNull(); // unknown username → null regardless of password
        } else if (password === first.password) {
          expect(result).toBe(first); // never authenticates against a LATER same-username record
          expect(result?.username).toBe(username);
        } else {
          expect(result).toBeNull(); // wrong password for an existing username → null
        }
      }),
    );
  });
});
