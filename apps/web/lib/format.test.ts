// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { gib, humanAgo, utcStamp } from "./format";

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

describe("humanAgo (deterministic — both instants passed in)", () => {
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  it("buckets by magnitude", () => {
    expect(humanAgo(t0, t0)).toBe("just now");
    expect(humanAgo(t0, t0 + 45_000)).toBe("just now");
    expect(humanAgo(t0, t0 + 5 * 60_000)).toBe("5m ago");
    expect(humanAgo(t0, t0 + (2 * 60 + 15) * 60_000)).toBe("2h 15m ago");
    expect(humanAgo(t0, t0 + 26 * 60 * 60_000)).toBe("1d 2h ago");
  });
  it("never goes negative (clock skew / future build)", () => {
    expect(humanAgo(t0, t0 - 10_000)).toBe("just now");
  });
});

describe("utcStamp", () => {
  it("renders a zero-padded UTC minute stamp regardless of local zone", () => {
    expect(utcStamp(Date.parse("2026-07-06T17:12:03Z"))).toBe("2026-07-06 17:12 UTC");
    expect(utcStamp(Date.parse("2026-01-02T03:04:00Z"))).toBe("2026-01-02 03:04 UTC");
  });
});
