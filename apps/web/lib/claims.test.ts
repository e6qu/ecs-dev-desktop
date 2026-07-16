// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { normalizeClaims } from "./claims";

describe("normalizeClaims", () => {
  it("maps a GitHub profile (no groups yet)", () => {
    expect(normalizeClaims("github", { id: 42 })).toEqual({
      idp: "github",
      subject: "42",
      groups: [],
    });
  });

  it("maps a Shauth ID token including its centrally-issued role", () => {
    expect(normalizeClaims("shauth", { sub: "user-123", role: "admin" })).toEqual({
      idp: "shauth",
      subject: "user-123",
      groups: [],
      role: "admin",
    });
  });

  it("maps an Entra profile with groups", () => {
    expect(normalizeClaims("microsoft-entra-id", { oid: "abc", groups: ["g1", "g2"] })).toEqual({
      idp: "entra",
      subject: "abc",
      groups: ["g1", "g2"],
    });
  });

  it("throws on an unknown provider", () => {
    expect(() => normalizeClaims("google", {})).toThrow(/unsupported/);
  });
});
