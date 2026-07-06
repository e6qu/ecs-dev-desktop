// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ownerId } from "@edd/core";

import {
  defineAbilityFor,
  effectiveRole,
  isRole,
  personasFor,
  ROLES,
  type Action,
  type Role,
  type Subject,
} from "./index";

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

describe("isRole", () => {
  it("accepts every real role, rejects everything else", () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    for (const bad of ["", "root", "Admin", "admin ", "viewer,member"]) {
      expect(isRole(bad)).toBe(false);
    }
  });
});

describe("effectiveRole (persona clamp)", () => {
  it("a persona at or below the real role is honored", () => {
    expect(effectiveRole("admin", "admin")).toBe("admin");
    expect(effectiveRole("admin", "member")).toBe("member");
    expect(effectiveRole("admin", "viewer")).toBe("viewer");
    expect(effectiveRole("member", "viewer")).toBe("viewer");
    expect(effectiveRole("member", "member")).toBe("member");
  });

  it("never escalates above the real role", () => {
    expect(effectiveRole("viewer", "member")).toBe("viewer");
    expect(effectiveRole("viewer", "admin")).toBe("viewer");
    expect(effectiveRole("member", "admin")).toBe("member");
  });

  it("an absent or invalid persona resolves to the real role unchanged", () => {
    expect(effectiveRole("admin", undefined)).toBe("admin");
    expect(effectiveRole("admin", "")).toBe("admin");
    expect(effectiveRole("admin", "Admin")).toBe("admin");
    expect(effectiveRole("admin", "root")).toBe("admin");
  });
});

describe("personasFor", () => {
  it("admin may switch into every role", () => {
    expect(personasFor("admin")).toEqual(["viewer", "member", "admin"]);
  });
  it("member may switch into member or viewer, never admin", () => {
    expect(personasFor("member")).toEqual(["viewer", "member"]);
  });
  it("viewer has no lower persona (itself only)", () => {
    expect(personasFor("viewer")).toEqual(["viewer"]);
  });
});
