// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerId } from "@edd/core";
import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";

import { principalFromSession, withPersona } from "./principal";

describe("principalFromSession", () => {
  it("returns null when there is no session", () => {
    expect(principalFromSession(null)).toBeNull();
  });

  it("extracts the id and role from a session", () => {
    const session: Session = {
      user: { id: "u1", role: "admin" },
      expires: "2026-12-31T00:00:00.000Z",
    };
    expect(principalFromSession(session)).toEqual({ id: "u1", role: "admin" });
  });
});

describe("withPersona", () => {
  const admin = { id: ownerId("u1"), role: "admin" as const };

  it("returns the principal unchanged when no persona cookie is present", () => {
    expect(withPersona(admin, undefined)).toBe(admin);
  });

  it("downgrades role and records realRole when a lower persona is set", () => {
    expect(withPersona(admin, "viewer")).toEqual({ ...admin, role: "viewer", realRole: "admin" });
  });

  it("ignores a persona that would escalate above the real role", () => {
    const member = { id: ownerId("u2"), role: "member" as const };
    expect(withPersona(member, "admin")).toBe(member);
  });

  it("ignores an invalid persona cookie value", () => {
    expect(withPersona(admin, "root")).toBe(admin);
  });
});
