// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  defaultTabLabel,
  displayTabLabel,
  moveInArray,
  nextActiveAfterClose,
  normalizeTabName,
} from "./tab-order";

describe("defaultTabLabel", () => {
  it("labels by stable id, not position (no duplicates after close-then-open)", () => {
    expect(defaultTabLabel(1)).toBe("Terminal 1");
    expect(defaultTabLabel(2)).toBe("Terminal 2");
    // Open t1,t2,t3; close t2; open t4 -> ids 1,3,4 -> labels never collide.
    expect([1, 3, 4].map(defaultTabLabel)).toEqual(["Terminal 1", "Terminal 3", "Terminal 4"]);
  });
});

describe("normalizeTabName", () => {
  it("trims, and maps empty/whitespace to null (the 'no name' state)", () => {
    expect(normalizeTabName("  build  ")).toBe("build");
    expect(normalizeTabName("build")).toBe("build");
    expect(normalizeTabName("")).toBeNull();
    expect(normalizeTabName("   ")).toBeNull();
  });
});

describe("displayTabLabel", () => {
  it("shows the custom name when set, else the id-based default", () => {
    expect(displayTabLabel("deploy", 5)).toBe("deploy");
    expect(displayTabLabel(null, 5)).toBe("Terminal 5");
  });
});

describe("moveInArray", () => {
  it("moves an element forward and backward, returning a new array", () => {
    const base = [10, 20, 30, 40];
    expect(moveInArray(base, 0, 2)).toEqual([20, 30, 10, 40]);
    expect(moveInArray(base, 3, 0)).toEqual([40, 10, 20, 30]);
    expect(base).toEqual([10, 20, 30, 40]); // input untouched (pure)
  });

  it("is a no-op copy for same index or out-of-range", () => {
    const base = [1, 2, 3];
    expect(moveInArray(base, 1, 1)).toEqual([1, 2, 3]);
    expect(moveInArray(base, -1, 2)).toEqual([1, 2, 3]);
    expect(moveInArray(base, 0, 9)).toEqual([1, 2, 3]);
  });
});

describe("nextActiveAfterClose", () => {
  it("keeps the active tab when a different tab closes", () => {
    expect(nextActiveAfterClose([1, 2, 3], 3, 1)).toBe(1);
  });

  it("focuses the tab that slides into the closed active slot", () => {
    // Close active 2 of [1,2,3] -> [1,3]; index 1 slot now holds 3.
    expect(nextActiveAfterClose([1, 2, 3], 2, 2)).toBe(3);
  });

  it("focuses the new last tab when the active last tab closes", () => {
    expect(nextActiveAfterClose([1, 2, 3], 3, 3)).toBe(2);
  });

  it("returns null when the final tab closes", () => {
    expect(nextActiveAfterClose([7], 7, 7)).toBeNull();
  });

  it("leaves active unchanged when the closing id is unknown", () => {
    expect(nextActiveAfterClose([1, 2], 9, 2)).toBe(2);
  });
});
