// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// `repoOwner` (the repo-URL → owner-login helper the git-credential route uses to
// pick a GitHub App installation) parses a stored, potentially odd `repoUrl`, so it
// must be total: never throw on arbitrary/odd strings, returning the first
// non-empty path segment or undefined.
import { repoOwner } from "../app/api/workspaces/[id]/git-credential/route";

describe("repoOwner (property)", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.string()), (repoUrl) => {
        expect(() => repoOwner(repoUrl)).not.toThrow();
      }),
    );
  });

  it("returns a string or undefined", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.webUrl(), fc.string()), (repoUrl) => {
        const owner = repoOwner(repoUrl);
        expect(owner === undefined || typeof owner === "string").toBe(true);
        if (typeof owner === "string") expect(owner.length).toBeGreaterThan(0);
      }),
    );
  });

  it("returns undefined when the input is undefined", () => {
    expect(repoOwner(undefined)).toBeUndefined();
  });

  it("extracts the first path segment of a well-formed https repo URL", () => {
    // Alphanumeric-led segments only, so URL path normalization (`.`/`..`) can't
    // rewrite the segment we assert on.
    const seg = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/);
    fc.assert(
      fc.property(seg, seg, (owner, repo) => {
        expect(repoOwner(`https://github.com/${owner}/${repo}.git`)).toBe(owner);
        expect(repoOwner(`https://github.com/${owner}/${repo}`)).toBe(owner);
      }),
    );
  });
});
