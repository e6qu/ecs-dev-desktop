// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based proof of the load-bearing confinement: resolveWithin either throws OR returns a
// path inside root — for ANY client-supplied path (traversal, absolute, unicode, dot segments).
import * as path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveWithin } from "./file-api";

const ROOTS = ["/tmp/ws", "/srv/a/b", "/home/workspace"] as const;

// A hostile-ish client path: normal segments mixed with traversal / absolute / unicode / empties.
const relArb = fc
  .array(
    fc.oneof(
      fc.constant(".."),
      fc.constant("."),
      fc.constant(""),
      fc.constantFrom("etc", "passwd", "ws-evil", "a", "b"),
      fc.string(),
      fc.string(),
    ),
    { maxLength: 8 },
  )
  .map((segs) => segs.join("/"));

describe("resolveWithin — path confinement (fuzz)", () => {
  it("never returns a path outside root (throws or stays confined)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROOTS),
        fc.oneof(relArb, fc.string(), fc.string()),
        (root, rel) => {
          const rootResolved = path.resolve(root);
          let resolved: string;
          try {
            resolved = resolveWithin(root, rel);
          } catch {
            return; // rejecting an escape is an allowed outcome
          }
          // If it returned a path, it MUST be the root itself or strictly inside it.
          expect(resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)).toBe(
            true,
          );
        },
      ),
    );
  });

  it("rejects parent-traversal + absolute + sibling-prefix escapes", () => {
    for (const root of ROOTS) {
      for (const evil of ["/etc/passwd", "../escape", "a/../../escape", "../ws-evil/x"]) {
        expect(() => resolveWithin(root, evil)).toThrow();
      }
    }
  });

  it("accepts safe relative paths without false rejection, and keeps them confined", () => {
    const safeSeg = fc
      .stringMatching(/^[A-Za-z0-9_.-]+$/)
      .filter((s) => s.length > 0 && s !== ".." && s !== ".");
    fc.assert(
      fc.property(
        fc.constantFrom(...ROOTS),
        fc.array(safeSeg, { minLength: 1, maxLength: 6 }),
        (root, segs) => {
          const resolved = resolveWithin(root, segs.join("/"));
          const rootResolved = path.resolve(root);
          // Confined: the root itself or strictly inside it. (Not a path.relative check — a valid
          // filename like "..." would make path.relative start with ".." yet never escape.)
          expect(resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)).toBe(
            true,
          );
        },
      ),
    );
  });
});
