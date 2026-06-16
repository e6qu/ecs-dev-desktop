// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { sshPublicKey } from "./ids";
import { fingerprintPublicKey, sshKeyType, workspacePrincipal, workspaceSshHost } from "./ssh";

// A real ed25519 public key + its `ssh-keygen -lf` SHA256 fingerprint. Inert
// fixture (never compared against the clock) — see AGENTS.md §6.10.
const PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4ZbjzMeOtIzbUqhfKMeKGhK/v/L86UOuNmnczpU42p vec@edd";
const FINGERPRINT = "SHA256:ZKsoxDkZEePudjxqp2aESf7WzZPoeDa7Mx4Dtddjjoo";

describe("workspacePrincipal", () => {
  it("prefixes a valid workspace id with dev-", () => {
    expect(workspacePrincipal("ws-abc123")).toBe("dev-ws-abc123");
  });

  it("rejects an id with illegal characters", () => {
    expect(() => workspacePrincipal("ws_abc!")).toThrow(/invalid workspaceId/);
  });
});

describe("workspaceSshHost", () => {
  it("builds <id>.<baseDomain>", () => {
    expect(workspaceSshHost("ws-abc123", "ssh.example.com")).toBe("ws-abc123.ssh.example.com");
  });

  it("shares the principal charset (rejects the same illegal ids)", () => {
    expect(() => workspaceSshHost("ws_abc!", "ssh.example.com")).toThrow(/invalid workspaceId/);
  });

  it("requires a base domain", () => {
    expect(() => workspaceSshHost("ws-abc123", "")).toThrow(/baseDomain is required/);
  });
});

describe("sshKeyType", () => {
  it("returns the algorithm field", () => {
    expect(sshKeyType(sshPublicKey(PUBKEY))).toBe("ssh-ed25519");
  });

  it("throws on an empty key", () => {
    expect(() => sshKeyType("   ")).toThrow(/no type field/);
  });
});

describe("fingerprintPublicKey", () => {
  it("matches `ssh-keygen -lf` (SHA256, base64, no padding)", () => {
    expect(fingerprintPublicKey(sshPublicKey(PUBKEY))).toBe(FINGERPRINT);
  });

  it("ignores the comment field (fingerprint is over the key blob only)", () => {
    const noComment = PUBKEY.split(/\s+/).slice(0, 2).join(" ");
    expect(fingerprintPublicKey(noComment)).toBe(FINGERPRINT);
  });

  it("throws loudly when there is no key material", () => {
    expect(() => fingerprintPublicKey("ssh-ed25519")).toThrow(/no key material/);
  });
});
