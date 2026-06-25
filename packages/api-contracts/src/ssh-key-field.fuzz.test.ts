// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared `sshPublicKeyField` is the 400-not-500 boundary: hostile key input must be rejected
// cleanly, a second key must never smuggle through a newline, and the alternation+base64 regex must
// not blow up (ReDoS) on arbitrary input. Exercised via the two exported contracts that use it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { registerSshKeyRequest, sshAuthorizeRequest } from "./index";

const KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];

const accepts = (publicKey: string): boolean =>
  sshAuthorizeRequest.safeParse({ publicKey }).success;

const validKeyArb = fc
  .tuple(
    fc.constantFrom(...KEY_TYPES),
    // A base64-charset blob (the field's regex checks the charset, not decodability).
    fc.stringMatching(/^[A-Za-z0-9+/]{20,200}={0,2}$/),
    fc.stringMatching(/^[A-Za-z0-9@._-]{0,30}$/),
  )
  .map(([type, blob, comment]) =>
    comment === "" ? `${type} ${blob}` : `${type} ${blob} ${comment}`,
  );

describe("sshPublicKeyField (fuzz) — the 400-not-500 boundary", () => {
  it("is total: safeParse over ANY string returns a boolean result (no throw, no ReDoS hang)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof sshAuthorizeRequest.safeParse({ publicKey: s }).success).toBe("boolean");
      }),
    );
  });

  it("accepts well-formed single-line keys", () => {
    fc.assert(
      fc.property(validKeyArb, (key) => {
        expect(accepts(key)).toBe(true);
      }),
    );
  });

  it("never lets a second key smuggle in through a newline", () => {
    fc.assert(
      fc.property(validKeyArb, validKeyArb, fc.constantFrom("\n", "\r", "\r\n"), (k1, k2, nl) => {
        expect(accepts(`${k1}${nl}${k2}`)).toBe(false);
      }),
    );
  });

  it("an accepted key starts with a known type and is within the 16 KiB cap", () => {
    fc.assert(
      fc.property(validKeyArb, (key) => {
        expect(registerSshKeyRequest.safeParse({ publicKey: key }).success).toBe(true);
        expect(KEY_TYPES.some((t) => key.startsWith(`${t} `))).toBe(true);
        expect(key.length).toBeLessThanOrEqual(16 * 1024);
      }),
    );
  });
});
