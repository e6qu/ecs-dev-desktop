// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken } from "./token-crypto";

const KEY = randomBytes(32).toString("hex");
const OTHER_KEY = randomBytes(32).toString("hex");

describe("token-crypto (AES-256-GCM at rest)", () => {
  it("round-trips a secret", () => {
    const secret = "ghp_exampleToken_not_real_1234567890";
    expect(decryptToken(encryptToken(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a fresh IV each time (ciphertext differs for the same input)", () => {
    const a = encryptToken("same", KEY);
    const b = encryptToken("same", KEY);
    expect(a).not.toBe(b);
    expect(decryptToken(a, KEY)).toBe("same");
    expect(decryptToken(b, KEY)).toBe("same");
  });

  it("fails to decrypt with the wrong key", () => {
    expect(() => decryptToken(encryptToken("secret", KEY), OTHER_KEY)).toThrow();
  });

  it("rejects a tampered ciphertext (auth tag)", () => {
    const blob = encryptToken("secret", KEY);
    const [iv, tag, ct] = blob.split(".");
    const flipped = Buffer.from(ct ?? "", "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered = [iv, tag, flipped.toString("base64")].join(".");
    expect(() => decryptToken(tampered, KEY)).toThrow();
  });

  it("rejects a malformed blob", () => {
    expect(() => decryptToken("not-a-valid-blob", KEY)).toThrow(/malformed/);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptToken("x", "abcd")).toThrow(/32 bytes/);
  });
});
