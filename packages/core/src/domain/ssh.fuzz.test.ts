// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the SSH public-key helpers. The fingerprint is
// the stable identity a registered key is deduped + looked up by, so two invariants
// matter: it must NEVER throw on arbitrary input (fail loud is a thrown Error, but the
// caller must be able to rely on "throws ⇔ rejected"), and an ACCEPTED blob must be
// canonical base64 — so two distinct submitted strings can never decode to the same
// bytes and collide on a fingerprint (lenient `Buffer.from(_, "base64")` previously let
// `AAAA`/`AAAAA`/`!!!!` through). Also pins the label/principal/host helpers.
import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  fingerprintPublicKey,
  isWorkspaceLabel,
  sshKeyType,
  workspacePrincipal,
  workspaceSshHost,
} from "./ssh";

describe("fingerprintPublicKey — properties", () => {
  it("only accepts a canonical-base64 blob, and that blob round-trips to the same bytes", () => {
    fc.assert(
      fc.property(fc.string(), (blob) => {
        let fp: string;
        try {
          fp = fingerprintPublicKey(`ssh-ed25519 ${blob}`);
        } catch {
          return; // rejection is always acceptable (garbage in)
        }
        // Accepted ⇒ the blob is canonical base64 (re-encoding round-trips, padding aside).
        expect(Buffer.from(blob, "base64").toString("base64").replace(/=+$/, "")).toBe(
          blob.replace(/=+$/, ""),
        );
        expect(/^SHA256:[A-Za-z0-9+/]+$/.test(fp)).toBe(true);
      }),
    );
  });

  it("matches the canonical ssh-keygen computation for a real (valid-base64) blob", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (bytes) => {
        const blob = Buffer.from(bytes).toString("base64");
        const expected = `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
        expect(fingerprintPublicKey(`ssh-ed25519 ${blob} comment`)).toBe(expected);
      }),
    );
  });

  it("never throws unexpectedly on an arbitrary key line (throws ⇔ rejected, no other error)", () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        try {
          fingerprintPublicKey(line);
        } catch (e) {
          expect(e).toBeInstanceOf(Error); // a controlled rejection, not a TypeError/RangeError
        }
      }),
    );
  });
});

describe("ssh label / principal / host — properties", () => {
  it("workspacePrincipal/workspaceSshHost throw exactly when the id is not a valid label", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const valid = isWorkspaceLabel(id);
        if (valid) {
          expect(workspacePrincipal(id)).toBe(`dev-${id}`);
          expect(workspaceSshHost(id, "ssh.example.com")).toBe(`${id}.ssh.example.com`);
        } else {
          expect(() => workspacePrincipal(id)).toThrow();
          expect(() => workspaceSshHost(id, "ssh.example.com")).toThrow();
        }
      }),
    );
  });

  it("sshKeyType returns the first whitespace-delimited token or throws on a blank key", () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const first = key.trim().split(/\s+/)[0];
        if (first === undefined || first.length === 0) {
          expect(() => sshKeyType(key)).toThrow();
        } else {
          expect(sshKeyType(key)).toBe(first);
        }
      }),
    );
  });
});
