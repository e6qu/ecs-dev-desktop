// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { withinWorkspaceQuota } from "./quota";

describe("withinWorkspaceQuota", () => {
  it("allows any count when the limit is unlimited (null)", () => {
    expect(withinWorkspaceQuota(0, null)).toBe(true);
    expect(withinWorkspaceQuota(999, null)).toBe(true);
  });

  it("allows creation strictly below the limit", () => {
    expect(withinWorkspaceQuota(0, 2)).toBe(true);
    expect(withinWorkspaceQuota(1, 2)).toBe(true);
  });

  it("blocks creation at or above the limit", () => {
    expect(withinWorkspaceQuota(2, 2)).toBe(false);
    expect(withinWorkspaceQuota(3, 2)).toBe(false);
    expect(withinWorkspaceQuota(0, 0)).toBe(false);
  });
});
