// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerId } from "@edd/core";
import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";

import {
  cookieValue,
  decodePersonaCookie,
  encodePersonaCookie,
  principalFromSession,
  withPersona,
} from "./principal";

describe("cookieValue", () => {
  it("returns a malformed percent-escape raw instead of throwing (fuzz counterexample)", () => {
    // Pinned fast-check counterexample (seed 929992131): decodeURIComponent
    // throws URIError on a truncated escape, and the Cookie header is
    // attacker-controlled on every request -- this must never crash a handler.
    expect(cookieValue("_=%", "_")).toBe("%");
    expect(cookieValue("edd-persona=%E0%A4%A", "edd-persona")).toBe("%E0%A4%A");
  });

  it("still URL-decodes well-formed values", () => {
    expect(cookieValue("a=hello%20world; b=2", "a")).toBe("hello world");
  });
});

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

  it("throws on an unknown role instead of falling back", () => {
    const session = {
      user: { id: "u1", role: "invalid-role" },
      expires: "2026-12-31T00:00:00.000Z",
    } as unknown as Session;
    expect(() => principalFromSession(session)).toThrow("role is invalid");
  });
});

describe("persona cookie schema (encode/decode)", () => {
  it("round-trips the current version", () => {
    expect(decodePersonaCookie(encodePersonaCookie("viewer"))).toBe("viewer");
  });

  it("reads any non-current shape as absent — never an error (§6.5a)", () => {
    expect(decodePersonaCookie(undefined)).toBeUndefined();
    expect(decodePersonaCookie("viewer")).toBeUndefined(); // legacy un-versioned value
    expect(decodePersonaCookie("999:viewer")).toBeUndefined(); // future/foreign version
    expect(decodePersonaCookie("")).toBeUndefined();
    expect(decodePersonaCookie("::")).toBeUndefined();
  });
});

describe("withPersona", () => {
  const admin = { id: ownerId("u1"), role: "admin" as const };

  it("returns the principal unchanged when no persona cookie is present", () => {
    expect(withPersona(admin, undefined)).toBe(admin);
  });

  it("downgrades role and records realRole when a lower persona is set", () => {
    expect(withPersona(admin, encodePersonaCookie("viewer"))).toEqual({
      ...admin,
      role: "viewer",
      realRole: "admin",
    });
  });

  it("ignores a persona that would escalate above the real role", () => {
    const developer = { id: ownerId("u2"), role: "developer" as const };
    expect(withPersona(developer, encodePersonaCookie("admin"))).toBe(developer);
  });

  it("ignores an invalid or legacy-schema persona cookie value", () => {
    expect(withPersona(admin, encodePersonaCookie("root"))).toBe(admin);
    expect(withPersona(admin, "viewer")).toBe(admin); // pre-versioning value → no override
  });
});
