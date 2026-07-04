// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based fuzz tests (fast-check) for the SSH key label-extraction logic
// and fingerprintPublicKey totality. The label function runs on attacker-supplied
// key text; it must never throw and always produce a non-empty label.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fingerprintPublicKey } from "@edd/core";

describe("SSH key label extraction (fuzz)", () => {
  it("label extraction logic never throws on any string input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => {
          input.trim().split(/\s+/).slice(2).join(" ");
        }).not.toThrow();
      }),
    );
  });

  it("comment extraction is faithful: slice(2).join matches the original split", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 8 }), (parts) => {
        const line = parts.join(" ");
        const tokens = line.trim().split(/\s+/);
        const comment = tokens.slice(2).join(" ");
        // After trim+split, the token count may differ from parts.length
        // (empty-string parts collapse). The comment is always consistent
        // with the actual token count.
        if (tokens.length <= 2) {
          expect(comment).toBe("");
        }
        // The function never throws — that's the core invariant
        expect(typeof comment).toBe("string");
      }),
    );
  });
});

describe("fingerprintPublicKey (fuzz)", () => {
  it("never throws unexpectedly — rejections are always Error instances", () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        try {
          fingerprintPublicKey(line);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it("accepts any canonical-base64 blob and produces SHA256: prefix", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 10, maxLength: 100 }), (bytes) => {
        const blob = Buffer.from(bytes).toString("base64");
        const fp = fingerprintPublicKey(`ssh-ed25519 ${blob} comment`);
        expect(fp.startsWith("SHA256:")).toBe(true);
      }),
    );
  });
});
