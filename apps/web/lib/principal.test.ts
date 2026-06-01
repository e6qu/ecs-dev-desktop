// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";

import { principalFromSession } from "./principal";

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
