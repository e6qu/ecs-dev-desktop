// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ownerId } from "@edd/core";

import { defineAbilityFor, ROLES, type Action, type Role, type Subject } from "./index";

const ACTIONS: Action[] = ["create", "read", "update", "delete", "manage"];
const SUBJECTS: Subject[] = ["Workspace", "User", "BaseImage", "all"];

/**
 * The complete role × action × subject truth table (TESTING.md: "admin / member
 * / viewer × every action"). Each entry lists the (action, subject) pairs that
 * role may perform; everything else must be denied. Admin holds `manage all`,
 * so it can do every pair — encoded as the sentinel `"*"`.
 */
const ALLOWED: Record<Role, [Action, Subject][] | "*"> = {
  viewer: [
    ["read", "Workspace"],
    ["read", "BaseImage"],
  ],
  member: [
    ["read", "Workspace"],
    ["read", "BaseImage"],
    ["create", "Workspace"],
    ["update", "Workspace"],
    ["delete", "Workspace"],
  ],
  admin: "*",
};

function isAllowed(role: Role, action: Action, subject: Subject): boolean {
  const spec = ALLOWED[role];
  if (spec === "*") return true;
  return spec.some(([a, s]) => a === action && s === subject);
}

describe("RBAC ability matrix (every role × action × subject)", () => {
  for (const role of ROLES) {
    const ability = defineAbilityFor({ id: ownerId("u"), role });
    for (const action of ACTIONS) {
      for (const subject of SUBJECTS) {
        const expected = isAllowed(role, action, subject);
        it(`${role} ${expected ? "CAN" : "cannot"} ${action} ${subject}`, () => {
          expect(ability.can(action, subject)).toBe(expected);
        });
      }
    }
  }

  it("a member cannot touch Users at all", () => {
    const a = defineAbilityFor({ id: ownerId("u"), role: "member" });
    for (const action of ACTIONS) expect(a.can(action, "User")).toBe(false);
  });

  it("a viewer cannot mutate the catalog or any workspace", () => {
    const a = defineAbilityFor({ id: ownerId("u"), role: "viewer" });
    for (const action of ["create", "update", "delete"] as const) {
      expect(a.can(action, "Workspace")).toBe(false);
      expect(a.can(action, "BaseImage")).toBe(false);
    }
  });
});
