// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { gib } from "./format";

// gib() MUST live in this plain module (never a "use client" one): WorkspaceCard
// is a server component and calls it during render. A "use client" export would
// throw "Attempted to call gib() from the server" — which 500'd the whole
// /workspaces page live once a workspace had reported disk usage.
describe("gib (server-safe byte formatter)", () => {
  it("formats bytes as one-decimal GiB", () => {
    expect(gib(0)).toBe("0.0 GiB");
    expect(gib(1024 ** 3)).toBe("1.0 GiB");
    expect(gib(1.5 * 1024 ** 3)).toBe("1.5 GiB");
    expect(gib(8 * 1024 ** 3)).toBe("8.0 GiB");
  });
});
