// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { andThen, err, isErr, isOk, map, mapErr, ok, type Result } from "./result";

// Returns a genuine union (not a statically-known Ok/Err) so narrowing is real.
const classify = (n: number): Result<number, string> => (n >= 0 ? ok(n) : err("negative"));

describe("Result", () => {
  it("constructs ok/err with their value/error", () => {
    const good = ok(1);
    expect(good.ok).toBe(true);
    expect(good.value).toBe(1);
    const bad = err("nope");
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("nope");
  });

  it("isOk/isErr narrow a union", () => {
    const a = classify(5);
    const b = classify(-1);
    expect(isOk(a)).toBe(true);
    expect(isErr(b)).toBe(true);
    if (isOk(a)) expect(a.value).toBe(5);
    if (isErr(b)) expect(b.error).toBe("negative");
  });

  it("map transforms the value, leaves an error untouched", () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(err<string>("e"), (n: number) => n * 3)).toEqual(err("e"));
  });

  it("mapErr transforms the error, leaves a success untouched", () => {
    expect(mapErr(err("boom"), (e) => e.length)).toEqual(err(4));
    expect(mapErr(ok<number>(7), (e: string) => e.length)).toEqual(ok(7));
  });

  it("andThen chains on success and short-circuits on error", () => {
    const half = (n: number): Result<number, string> => (n % 2 === 0 ? ok(n / 2) : err("odd"));
    expect(andThen(ok(8), half)).toEqual(ok(4));
    expect(andThen(ok(7), half)).toEqual(err("odd"));
    expect(andThen(err<string>("prior"), half)).toEqual(err("prior"));
  });
});
