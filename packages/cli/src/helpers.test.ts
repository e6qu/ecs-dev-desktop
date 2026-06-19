// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { authHeaders, sym } from "./helpers";

describe("authHeaders", () => {
  it("uses a bearer token when EDD_API_TOKEN is set", () => {
    expect(authHeaders({ EDD_API_TOKEN: "secret" })).toEqual({ Authorization: "Bearer secret" });
  });

  it("falls back to the dev-auth shim (default admin/admin)", () => {
    expect(authHeaders({})).toEqual({ "x-edd-user-id": "admin", "x-edd-role": "admin" });
    expect(authHeaders({ EDD_USER: "ops", EDD_ROLE: "viewer" })).toEqual({
      "x-edd-user-id": "ops",
      "x-edd-role": "viewer",
    });
  });
});

describe("sym", () => {
  it("maps statuses to glyphs", () => {
    expect(sym("ok")).toBe("✓");
    expect(sym("drift")).toBe("✗");
    expect(sym("down")).toBe("✗");
    expect(sym("unknown")).toBe("?");
  });
});
