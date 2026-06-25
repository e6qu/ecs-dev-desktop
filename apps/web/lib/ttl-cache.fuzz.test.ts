// SPDX-License-Identifier: AGPL-3.0-or-later
// ttlCache memoises a fleet scan; its correctness (load exactly once per fresh window, single-flight,
// reject-not-cached) is subtle and time-driven — and time is injected, so it's deterministically fuzzable.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ttlCache } from "./ttl-cache";

describe("ttlCache (fuzz)", () => {
  it("loads iff fresh (no entry, or now - lastLoad >= ttl); shares the value within the window", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        fc.array(fc.nat({ max: 5000 }), { maxLength: 30 }),
        async (ttlMs, deltas) => {
          let loads = 0;
          const cache = ttlCache(() => Promise.resolve(++loads), ttlMs);
          let now = 0;
          let lastLoadAt: number | undefined;
          let expected = 0;
          for (const d of deltas) {
            now += d; // monotonic clock
            if (lastLoadAt === undefined || now - lastLoadAt >= ttlMs) {
              expected += 1;
              lastLoadAt = now;
            }
            await cache(now);
          }
          expect(loads).toBe(expected);
        },
      ),
    );
  });

  it("shares ONE in-flight load across N concurrent same-time callers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 1000 }),
        async (n, ttlMs) => {
          let loads = 0;
          let resolve: ((v: number) => void) | undefined;
          const cache = ttlCache(() => {
            loads += 1;
            return new Promise<number>((r) => (resolve = r));
          }, ttlMs);
          const pending = Array.from({ length: n }, () => cache(0));
          resolve?.(42);
          const results = await Promise.all(pending);
          expect(loads).toBe(1);
          expect(results.every((r) => r === 42)).toBe(true);
        },
      ),
    );
  });

  it("does not cache a rejected load — the next call (within TTL) retries", async () => {
    let loads = 0;
    const cache = ttlCache(() => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(loads);
    }, 1000);
    await expect(cache(0)).rejects.toThrow("boom");
    await expect(cache(1)).resolves.toBe(2); // within TTL, but the prior load rejected → reload
    expect(loads).toBe(2);
  });
});
