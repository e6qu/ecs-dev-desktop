// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { deriveWorkspaceToken, verifyWorkspaceToken } from "./machine-token";

// A fixed hex secret used as an inert input (never compared against the real clock).
const SECRET = "00112233445566778899aabbccddeeff";

describe("deriveWorkspaceToken", () => {
  it("is deterministic for a (secret, workspaceId) pair", () => {
    expect(deriveWorkspaceToken(SECRET, "ws-abc")).toBe(deriveWorkspaceToken(SECRET, "ws-abc"));
  });

  it("is per-workspace: a token for one workspace differs from another's", () => {
    expect(deriveWorkspaceToken(SECRET, "ws-abc")).not.toBe(deriveWorkspaceToken(SECRET, "ws-xyz"));
  });

  it("is a 64-char hex string (SHA-256)", () => {
    expect(deriveWorkspaceToken(SECRET, "ws-abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the secret", () => {
    expect(deriveWorkspaceToken(SECRET, "ws-abc")).not.toBe(
      deriveWorkspaceToken("ffffffffffffffffffffffffffffffff", "ws-abc"),
    );
  });

  it("throws on an empty secret (fails loud)", () => {
    expect(() => deriveWorkspaceToken("", "ws-abc")).toThrow(/empty secret/);
  });
});

describe("verifyWorkspaceToken", () => {
  it("accepts the matching token", () => {
    const token = deriveWorkspaceToken(SECRET, "ws-abc");
    expect(verifyWorkspaceToken(SECRET, "ws-abc", token)).toBe(true);
  });

  it("rejects a token derived for a different workspace", () => {
    const other = deriveWorkspaceToken(SECRET, "ws-xyz");
    expect(verifyWorkspaceToken(SECRET, "ws-abc", other)).toBe(false);
  });

  it("rejects a garbage / wrong-length candidate without throwing", () => {
    expect(verifyWorkspaceToken(SECRET, "ws-abc", "deadbeef")).toBe(false);
    expect(verifyWorkspaceToken(SECRET, "ws-abc", "")).toBe(false);
  });

  it("fails closed when the secret is empty", () => {
    expect(verifyWorkspaceToken("", "ws-abc", "anything")).toBe(false);
  });
});
