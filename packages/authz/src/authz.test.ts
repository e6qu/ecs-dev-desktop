// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { defineAbilityFor } from "./index";

describe("RBAC abilities", () => {
  it("admin can manage everything", () => {
    const a = defineAbilityFor({ id: "u", role: "admin" });
    expect(a.can("delete", "User")).toBe(true);
    expect(a.can("manage", "all")).toBe(true);
  });

  it("member can create workspaces but not manage users", () => {
    const a = defineAbilityFor({ id: "u", role: "member" });
    expect(a.can("create", "Workspace")).toBe(true);
    expect(a.can("delete", "User")).toBe(false);
  });

  it("viewer can read but not create workspaces", () => {
    const a = defineAbilityFor({ id: "u", role: "viewer" });
    expect(a.can("read", "Workspace")).toBe(true);
    expect(a.can("create", "Workspace")).toBe(false);
  });
});
