// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { applyBaseImagePatch, findEnabledImage, provisionBaseImage } from "./base-image-catalog";
import { baseImage, baseImageId, isoTimestamp } from "./ids";

const AT = isoTimestamp("2026-06-03T00:00:00.000Z");
const entry = (over: Partial<Parameters<typeof provisionBaseImage>[0]> = {}) =>
  provisionBaseImage({
    id: baseImageId("img-1"),
    name: "Node 20",
    image: baseImage("golden/node:20"),
    at: AT,
    ...over,
  });

describe("provisionBaseImage", () => {
  it("constructs an enabled entry with defaults", () => {
    const e = entry();
    expect(e).toMatchObject({ name: "Node 20", enabled: true, description: "" });
  });

  it("rejects an empty name or image", () => {
    expect(() => entry({ name: "  " })).toThrow();
    expect(() => entry({ image: baseImage("") })).toThrow();
  });
});

describe("applyBaseImagePatch", () => {
  it("updates only the provided fields", () => {
    const e = entry({ description: "old" });
    const next = applyBaseImagePatch(e, { enabled: false });
    expect(next).toMatchObject({ enabled: false, name: "Node 20", description: "old" });
    expect(next.image).toBe(e.image); // image ref is immutable
  });

  it("rejects a blank name", () => {
    expect(() => applyBaseImagePatch(entry(), { name: "" })).toThrow();
  });
});

describe("findEnabledImage", () => {
  const catalog = [
    entry({ id: baseImageId("img-1"), image: baseImage("golden/node:20") }),
    entry({ id: baseImageId("img-2"), image: baseImage("golden/go:1.22"), enabled: false }),
  ];

  it("returns the enabled entry for an image", () => {
    expect(findEnabledImage(catalog, baseImage("golden/node:20"))?.id).toBe("img-1");
  });

  it("ignores disabled entries and unknown images", () => {
    expect(findEnabledImage(catalog, baseImage("golden/go:1.22"))).toBeUndefined();
    expect(findEnabledImage(catalog, baseImage("nope"))).toBeUndefined();
  });
});
