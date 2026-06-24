// SPDX-License-Identifier: AGPL-3.0-or-later
// Property-based tests (fast-check) for the base-image catalog pure functions. Pins:
// label normalization (via the public provision/patch surface) is trim + dedup +
// drop-blank and idempotent; an empty/whitespace name always fails loud; an empty patch
// is identity; and `findEnabledImage` never returns a disabled entry. `normalizeLabels`
// is private, so we assert its contract through the two functions that apply it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { baseImage, baseImageId, isoTimestamp, type BaseImage, type IsoTimestamp } from "./ids";
import {
  applyBaseImagePatch,
  findEnabledImage,
  provisionBaseImage,
  type BaseImageEntry,
  type BaseImagePatch,
} from "./base-image-catalog";

const AT: IsoTimestamp = isoTimestamp("2026-01-01T00:00:00.000Z");
// A label string that, after trimming, may be empty (whitespace-only) or duplicate.
const labelArb = fc.oneof(
  fc.string(),
  // Bias toward whitespace-padded and duplicate-prone values.
  fc.constantFrom("a", "b", " a ", "a ", "  ", "", "\t", "x\ty"),
);
const labelsArb = fc.array(labelArb, { maxLength: 12 });

/** The contract `normalizeLabels` guarantees, computed in the test: trim, drop blanks,
 * keep first occurrence (dedup), preserve order. */
const expectedNormalized = (labels: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const t = raw.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
};

const validNameArb = fc.string().filter((s) => s.trim() !== "");

describe("provisionBaseImage — normalization + fail-loud", () => {
  it("normalizes tags/tools (trim, drop-blank, dedup, order-preserving)", () => {
    fc.assert(
      fc.property(validNameArb, labelsArb, labelsArb, (name, tags, tools) => {
        const entry = provisionBaseImage({
          id: baseImageId("img-1"),
          name,
          image: baseImage("ecr/repo:tag"),
          tags,
          tools,
          at: AT,
        });
        expect([...entry.tags]).toEqual(expectedNormalized(tags));
        expect([...entry.tools]).toEqual(expectedNormalized(tools));
        // No blanks, all trimmed, no duplicates.
        for (const t of [...entry.tags, ...entry.tools]) {
          expect(t).toBe(t.trim());
          expect(t.length).toBeGreaterThan(0);
        }
        expect(new Set(entry.tags).size).toBe(entry.tags.length);
        // The persisted name is the trimmed input.
        expect(entry.name).toBe(name.trim());
      }),
    );
  });

  it("normalization is idempotent — re-normalizing already-clean labels is a fixpoint", () => {
    fc.assert(
      fc.property(validNameArb, labelsArb, (name, tags) => {
        const first = provisionBaseImage({
          id: baseImageId("img-1"),
          name,
          image: baseImage("ecr/repo:tag"),
          tags,
          at: AT,
        });
        const second = provisionBaseImage({
          id: baseImageId("img-1"),
          name,
          image: baseImage("ecr/repo:tag"),
          tags: first.tags,
          at: AT,
        });
        expect([...second.tags]).toEqual([...first.tags]);
      }),
    );
  });

  it("fails loud on a blank / whitespace-only name", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.trim() === ""),
        (blank) => {
          expect(() =>
            provisionBaseImage({
              id: baseImageId("img-1"),
              name: blank,
              image: baseImage("ecr/repo:tag"),
              at: AT,
            }),
          ).toThrow();
        },
      ),
    );
  });
});

/** An arbitrary, already-normalized catalog entry. */
const entryArb: fc.Arbitrary<BaseImageEntry> = fc.record({
  id: validNameArb.map((s) => baseImageId(`id-${s}`)),
  name: validNameArb,
  image: validNameArb.map((s) => baseImage(`ecr/${s}`)),
  description: fc.string(),
  tags: labelsArb.map(expectedNormalized),
  tools: labelsArb.map(expectedNormalized),
  enabled: fc.boolean(),
  editor: fc.constantFrom("openvscode" as const, "monaco" as const),
  createdAt: fc.constant(AT),
});

describe("applyBaseImagePatch — identity + fail-loud", () => {
  it("an empty patch is the identity", () => {
    fc.assert(
      fc.property(entryArb, (entry) => {
        const patched = applyBaseImagePatch(entry, {});
        expect(patched).toEqual(entry);
      }),
    );
  });

  it("a blank patch name fails loud; a present name is trimmed and applied", () => {
    fc.assert(
      fc.property(entryArb, fc.string(), (entry, newName) => {
        const patch: BaseImagePatch = { name: newName };
        if (newName.trim() === "") {
          expect(() => applyBaseImagePatch(entry, patch)).toThrow();
        } else {
          expect(applyBaseImagePatch(entry, patch).name).toBe(newName.trim());
        }
      }),
    );
  });

  it("undefined patch fields leave the corresponding value intact", () => {
    fc.assert(
      fc.property(entryArb, fc.boolean(), (entry, enabled) => {
        // Only `enabled` set: everything else must be preserved verbatim.
        const patched = applyBaseImagePatch(entry, { enabled });
        expect(patched.enabled).toBe(enabled);
        expect(patched.name).toBe(entry.name);
        expect([...patched.tags]).toEqual([...entry.tags]);
        expect([...patched.tools]).toEqual([...entry.tools]);
        expect(patched.description).toBe(entry.description);
        expect(patched.id).toBe(entry.id);
        expect(patched.image).toBe(entry.image);
      }),
    );
  });
});

describe("findEnabledImage — never returns a disabled entry", () => {
  it("returns undefined or an enabled entry whose image matches", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 10 }), entryArb, (catalog, probe) => {
        const target: BaseImage = probe.image;
        const found = findEnabledImage(catalog, target);
        if (found !== undefined) {
          expect(found.enabled).toBe(true);
          expect(found.image).toBe(target);
        } else {
          // No enabled entry matches the target image.
          expect(catalog.some((e) => e.enabled && e.image === target)).toBe(false);
        }
      }),
    );
  });

  it("a catalog of only-disabled matches never yields a result", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 8 }), (catalog) => {
        const disabledOnly = catalog.map((e): BaseImageEntry => ({ ...e, enabled: false }));
        for (const e of disabledOnly) {
          expect(findEnabledImage(disabledOnly, e.image)).toBeUndefined();
        }
      }),
    );
  });
});
