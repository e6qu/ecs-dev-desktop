// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// `repoRef` (the repo-URL → {owner, name} helper the git-credential route uses to pick a
// GitHub App installation AND scope the minted token to one repo) parses a stored,
// potentially odd `repoUrl`, so it must be total: never throw on arbitrary/odd strings,
// returning the owner + repo name (`.git` stripped) or undefined.
import { repoRef } from "../app/api/workspaces/[id]/git-credential/route";

describe("repoRef (property)", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.string()), (repoUrl) => {
        expect(() => repoRef(repoUrl)).not.toThrow();
      }),
    );
  });

  it("returns a well-formed {owner, name} or undefined", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.webUrl(), fc.string()), (repoUrl) => {
        const ref = repoRef(repoUrl);
        if (ref !== undefined) {
          expect(ref.owner.length).toBeGreaterThan(0);
          expect(ref.name.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("returns undefined when the input is undefined or has no repo segment", () => {
    expect(repoRef(undefined)).toBeUndefined();
    expect(repoRef("https://github.com/owner-only")).toBeUndefined();
  });

  it("extracts owner + repo (stripping .git) of a well-formed https repo URL", () => {
    // Alphanumeric-led segments only, so URL path normalization (`.`/`..`) can't
    // rewrite the segments we assert on.
    const seg = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/);
    fc.assert(
      fc.property(seg, seg, (owner, repo) => {
        expect(repoRef(`https://github.com/${owner}/${repo}.git`)).toEqual({ owner, name: repo });
        expect(repoRef(`https://github.com/${owner}/${repo}`)).toEqual({ owner, name: repo });
      }),
    );
  });
});
