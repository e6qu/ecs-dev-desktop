// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-workspace machine token derivation (pure). Every non-interactive trust in the
 * platform — the idle-agent heartbeat, the SSH gateway's wake calls, and the
 * editor's OpenVSCode connection token — is a stable per-workspace value derived as
 * `HMAC-SHA256(hex(secret), workspaceId)`. The secret is shared out-of-band with the
 * relevant component; the workspace id scopes the token so one observed for workspace
 * A cannot act on workspace B. Deriving here (one definition) keeps the producer (the
 * compute provider, which injects the token into the task) and the verifier/consumer
 * (the control plane) in lockstep.
 */

/** Derive the per-workspace token from a hex-encoded shared secret. Throws on an empty
 * secret (a token can never be valid without one — fail loud rather than emit a token
 * keyed on the empty string). */
export function deriveWorkspaceToken(secretHex: string, workspaceId: string): string {
  if (secretHex.length === 0) throw new Error("deriveWorkspaceToken: empty secret");
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(workspaceId).digest("hex");
}

/** Constant-time check that `candidate` is the token for `workspaceId` under `secretHex`.
 * Returns false (never throws) for an empty secret or a length mismatch, so callers fail
 * closed. */
export function verifyWorkspaceToken(
  secretHex: string,
  workspaceId: string,
  candidate: string,
): boolean {
  if (secretHex.length === 0) return false;
  const expectedBuf = Buffer.from(deriveWorkspaceToken(secretHex, workspaceId));
  const candidateBuf = Buffer.from(candidate);
  // Compare on BYTE length, not string (UTF-16 code-unit) length: an
  // attacker-controlled `candidate` with the same code-unit length but a different
  // UTF-8 byte length (e.g. a multi-byte char) would otherwise pass a string-length
  // guard and make `timingSafeEqual` THROW (it requires equal byte length) — breaking
  // the documented "never throws → callers fail closed" contract.
  if (expectedBuf.length !== candidateBuf.length) return false;
  return timingSafeEqual(expectedBuf, candidateBuf);
}
