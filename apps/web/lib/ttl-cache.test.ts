// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

import { ttlCache } from "./ttl-cache";

describe("ttlCache", () => {
  it("loads once and serves the cached value within the TTL", async () => {
    const load = vi.fn(() => Promise.resolve(42));
    const cached = ttlCache(load, 10_000);

    expect(await cached(0)).toBe(42);
    expect(await cached(5_000)).toBe(42); // within TTL → cached
    expect(await cached(9_999)).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads after the TTL elapses", async () => {
    let n = 0;
    const cached = ttlCache(() => Promise.resolve(++n), 10_000);

    expect(await cached(0)).toBe(1);
    expect(await cached(10_000)).toBe(2); // TTL boundary is exclusive (>= ttl reloads)
    expect(await cached(15_000)).toBe(2);
    expect(await cached(20_001)).toBe(3);
  });

  it("shares a single in-flight load across concurrent callers", async () => {
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            resolve("v");
          }, 5),
        ),
    );
    const cached = ttlCache(load, 10_000);

    const [a, b, c] = await Promise.all([cached(0), cached(0), cached(0)]);
    expect([a, b, c]).toEqual(["v", "v", "v"]);
    expect(load).toHaveBeenCalledTimes(1); // single-flight
  });

  it("does not cache a rejection — the next call retries", async () => {
    let calls = 0;
    const load = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok");
    });
    const cached = ttlCache(load, 10_000);

    await expect(cached(0)).rejects.toThrow("boom");
    expect(await cached(1)).toBe("ok"); // within the TTL, but the rejection was not cached
    expect(load).toHaveBeenCalledTimes(2);
  });
});
