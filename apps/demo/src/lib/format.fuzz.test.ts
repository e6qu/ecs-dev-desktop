// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pct, relTime, usd } from "./format";

describe("usd (fuzz)", () => {
  it("always returns a $-prefixed string and never a literal $NaN/$∞", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity)),
        (value) => {
          const out = usd(value);
          expect(out).toMatch(/^-?\$[\d,]+(\.\d{2})?$/);
        },
      ),
    );
  });
});

describe("pct (fuzz)", () => {
  it("always returns a finite value in [0,100] — incl. NaN/Infinity inputs (the cost-bar width)", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity)),
        fc.oneof(fc.double(), fc.constant(0), fc.constant(-1)),
        (value, maxUsd) => {
          const r = pct(value, maxUsd);
          expect(Number.isFinite(r)).toBe(true);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(100);
        },
      ),
    );
  });
});

describe("relTime (fuzz, controlled clock per §6.10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is total; an elapsed >= 1 day always renders as 'Nd ago'", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000 }), (daysAgo) => {
        const iso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
        expect(relTime(iso)).toMatch(/^\d+d ago$/);
      }),
    );
  });

  it("future + unparseable timestamps fall back to 'just now' (never throws)", () => {
    expect(relTime("not-a-date")).toBe("just now");
    expect(relTime(new Date(Date.now() + 99_000_000).toISOString())).toBe("just now");
  });
});
