// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the per-workspace machine-token derivation +
// verification — every non-interactive trust boundary (idle-agent heartbeat, SSH
// gateway wake, editor connection token). The load-bearing invariant is fail-closed:
// `verifyWorkspaceToken` must be TOTAL (never throw) for ANY candidate string — an
// attacker controls the candidate — and return true iff the candidate equals the
// derived token. (It previously threw on a same-code-unit-length but different-BYTE-length
// candidate, e.g. a multi-byte char, breaking the "never throws → callers fail closed"
// contract.)
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { deriveWorkspaceToken, verifyWorkspaceToken } from "./machine-token";

/** A non-empty hex secret (even length), the shape `Buffer.from(_, "hex")` expects. */
const secretArb = fc
  .uint8Array({ minLength: 1, maxLength: 32 })
  .map((b) => Buffer.from(b).toString("hex"));
const wsArb = fc.string({ minLength: 1, maxLength: 40 });

describe("machine-token — properties", () => {
  it("verify is total (never throws) and true iff candidate equals the derived token", () => {
    fc.assert(
      fc.property(secretArb, wsArb, fc.string(), (secret, ws, candidate) => {
        let threw = false;
        let result = false;
        try {
          result = verifyWorkspaceToken(secret, ws, candidate);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false); // verifyWorkspaceToken must never throw
        expect(result).toBe(candidate === deriveWorkspaceToken(secret, ws));
      }),
    );
  });

  it("accepts the genuinely-derived token and is workspace-scoped", () => {
    fc.assert(
      fc.property(secretArb, wsArb, wsArb, (secret, wsA, wsB) => {
        const tokenA = deriveWorkspaceToken(secret, wsA);
        expect(verifyWorkspaceToken(secret, wsA, tokenA)).toBe(true);
        // A token for wsA verifies for wsB only when the ids collide (HMAC scoping).
        expect(verifyWorkspaceToken(secret, wsB, tokenA)).toBe(wsA === wsB);
      }),
    );
  });

  it("rejects (never throws) under an empty secret regardless of candidate", () => {
    fc.assert(
      fc.property(wsArb, fc.string(), (ws, candidate) => {
        expect(verifyWorkspaceToken("", ws, candidate)).toBe(false);
      }),
    );
  });

  it("derivation is deterministic and a hex sha256 (64 chars)", () => {
    fc.assert(
      fc.property(secretArb, wsArb, (secret, ws) => {
        const a = deriveWorkspaceToken(secret, ws);
        expect(a).toBe(deriveWorkspaceToken(secret, ws));
        expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
      }),
    );
  });
});
