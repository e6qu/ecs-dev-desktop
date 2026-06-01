// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { roleMappingConfig } from "./auth-config";
import { ADMIN_GROUPS_ENV, MEMBER_GROUPS_ENV } from "./constants";

describe("roleMappingConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses comma-separated group lists", () => {
    vi.stubEnv(ADMIN_GROUPS_ENV, "a1, a2");
    vi.stubEnv(MEMBER_GROUPS_ENV, "m1");
    const c = roleMappingConfig();
    expect(c.adminGroups).toEqual(["a1", "a2"]);
    expect(c.memberGroups).toEqual(["m1"]);
    expect(c.defaultRole).toBe("viewer");
  });

  it("defaults to empty lists when unset", () => {
    expect(roleMappingConfig().adminGroups).toEqual([]);
    expect(roleMappingConfig().memberGroups).toEqual([]);
  });
});
