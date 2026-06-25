// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based coverage for the at-rest token cipher (AES-256-GCM): exact round-trip, fresh IV,
// fail-closed on wrong-key/tamper, and a controlled (not raw-TypeError) rejection of malformed blobs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken } from "./token-crypto";

const keyArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => Buffer.from(b).toString("hex"));

describe("token-crypto (fuzz)", () => {
  it("round-trips any plaintext: decrypt(encrypt(p)) === p", () => {
    fc.assert(
      fc.property(fc.string(), keyArb, (plaintext, key) => {
        expect(decryptToken(encryptToken(plaintext, key), key)).toBe(plaintext);
      }),
    );
  });

  it("uses a fresh IV: two encryptions of the same plaintext differ but both decrypt back", () => {
    fc.assert(
      fc.property(fc.string(), keyArb, (plaintext, key) => {
        const a = encryptToken(plaintext, key);
        const b = encryptToken(plaintext, key);
        expect(a).not.toBe(b);
        expect(decryptToken(a, key)).toBe(plaintext);
        expect(decryptToken(b, key)).toBe(plaintext);
      }),
    );
  });

  it("fails closed: a wrong key throws; a tampered ciphertext throws or still yields the original", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), keyArb, keyArb, (plaintext, key, otherKey) => {
        fc.pre(key !== otherKey);
        const blob = encryptToken(plaintext, key);
        expect(() => decryptToken(blob, otherKey)).toThrow();

        const [ivB64, tagB64, ctB64 = ""] = blob.split(".");
        const flipped = (ctB64.startsWith("A") ? "B" : "A") + ctB64.slice(1);
        let result: string | undefined;
        try {
          result = decryptToken(`${String(ivB64)}.${String(tagB64)}.${flipped}`, key);
        } catch {
          result = undefined; // GCM auth rejected the tamper — the expected path
        }
        // GCM guarantees: it never decrypts a tampered blob to a DIFFERENT plaintext.
        if (result !== undefined) expect(result).toBe(plaintext);
      }),
    );
  });

  it("rejects malformed blobs with a controlled Error, never a raw crypto TypeError", () => {
    const key = "ab".repeat(32);
    for (const bad of ["", "onlyonepart", "two.parts", "!!!.zz.zz", "a.b.c"]) {
      let err: unknown;
      try {
        decryptToken(bad, key);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
    }
  });
});
