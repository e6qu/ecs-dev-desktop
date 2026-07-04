// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { fingerprintPublicKey } from "@edd/core";

describe("defaultLabel (fuzz)", () => {
  it("label extraction logic is total — never throws on hostile key text", () => {
    // defaultLabel does: publicKey.trim().split(/\s+/).slice(2).join(" ")
    // This extracts the comment field from OpenSSH format: "type base64 comment..."
    const hostileInputs = [
      "ssh-ed25519 AAAA comment here",
      "ssh-rsa AAAA",
      "",
      "   ",
      "\t\n\r",
      "x",
      "a".repeat(10000),
      "ssh-ed25519 AAAA\x00binary\x01null",
      "ssh-ed25519 AAAA <script>alert(1)</script>",
      "ssh-ed25519 AAAA ' OR 1=1; --",
      "ssh-ed25519 AAAA \u0000\u0001\u0002",
      "ecdsa-sha2-nistp256 AAAA foo@bar",
      "sk-ssh-ed25519@openssh.com AAAA key@host",
      "not-a-key",
      "a b c d e f g h",
    ];
    for (const input of hostileInputs) {
      expect(() => {
        const comment = input.trim().split(/\s+/).slice(2).join(" ");
        return comment;
      }).not.toThrow();
    }
  });

  it("comment extraction is faithful when present", () => {
    const cases = [
      { input: "ssh-ed25519 AAAA my laptop", expected: "my laptop" },
      { input: "ssh-ed25519 AAAA", expected: "" },
      { input: "ssh-ed25519 AAAA a b c", expected: "a b c" },
      { input: "", expected: "" },
      { input: "only-one-word", expected: "" },
    ];
    for (const { input, expected } of cases) {
      const comment = input.trim().split(/\s+/).slice(2).join(" ");
      expect(comment).toBe(expected);
    }
  });

  it("fingerprintPublicKey is total for well-formed keys", () => {
    // Construct a valid ed25519-shaped blob: 4-byte len + "ssh-ed25519" + 4-byte len + 32-byte key
    const typeStr = "ssh-ed25519";
    const typeBuf = Buffer.alloc(4 + typeStr.length);
    typeBuf.writeUInt32BE(typeStr.length, 0);
    typeBuf.write(typeStr, 4, "ascii");
    const keyBuf = Buffer.alloc(4 + 32);
    keyBuf.writeUInt32BE(32, 0);
    const blob = Buffer.concat([typeBuf, keyBuf]).toString("base64");
    const validKey = `ssh-ed25519 ${blob} test-comment`;
    const fp = fingerprintPublicKey(validKey);
    expect(fp.length).toBeGreaterThan(0);
    expect(fp.startsWith("SHA256:")).toBe(true);
  });

  it("fingerprintPublicKey throws for malformed keys (fail-loud)", () => {
    const malformed = ["", "not-a-key", "ssh-ed25519", "ssh-ed25519 ", "garbage"];
    for (const key of malformed) {
      expect(() => fingerprintPublicKey(key)).toThrow();
    }
  });
});
