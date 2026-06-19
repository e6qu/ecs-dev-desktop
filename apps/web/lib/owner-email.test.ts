// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { resolveOwnerEmail } from "./owner-email";

describe("resolveOwnerEmail (proxy-routable owner identity at create)", () => {
  it("accepts and normalises a valid email", () => {
    const r = resolveOwnerEmail("User@Example.COM", false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe("user@example.com");
  });

  it("REJECTS a malformed email instead of silently dropping it (§6.5)", () => {
    const r = resolveOwnerEmail("not-an-email", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("malformed");
  });

  it("REJECTS a real (non-dev) session with no email — would be unopenable via the proxy", () => {
    const r = resolveOwnerEmail(undefined, false);
    expect(r.ok).toBe(false);
  });

  it("allows an absent email only under the dev-auth shim", () => {
    const r = resolveOwnerEmail(undefined, true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBeUndefined();
  });

  it("still rejects a malformed email even under dev-auth (never swallow garbage)", () => {
    expect(resolveOwnerEmail("bad", true).ok).toBe(false);
  });
});
