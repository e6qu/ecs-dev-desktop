// SPDX-License-Identifier: AGPL-3.0-or-later
// parseMessage is the untrusted boundary between raw browser WebSocket frames and the PTY.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseMessage } from "./terminal";

describe("parseMessage (fuzz)", () => {
  it("is total: any string / any JSON returns input|resize|null and never throws", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (raw) => {
        const r = parseMessage(raw);
        if (r === null) return;
        const validInput = "input" in r && typeof r.input === "string";
        const validResize =
          "cols" in r &&
          Number.isInteger(r.cols) &&
          r.cols > 0 &&
          Number.isInteger(r.rows) &&
          r.rows > 0;
        expect(validInput || validResize).toBe(true);
      }),
    );
  });

  it("accepts well-formed input + resize", () => {
    fc.assert(
      fc.property(fc.string(), (data) => {
        expect(parseMessage(JSON.stringify({ type: "input", data }))).toEqual({ input: data });
      }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (cols, rows) => {
          expect(parseMessage(JSON.stringify({ type: "resize", cols, rows }))).toEqual({
            cols,
            rows,
          });
        },
      ),
    );
  });

  it("rejects non-integer / non-positive PTY dimensions (no NaN/float/<=0 reaching pty.resize)", () => {
    for (const bad of [1.5, -1, 0, NaN, Infinity]) {
      expect(parseMessage(JSON.stringify({ type: "resize", cols: bad, rows: 24 }))).toBeNull();
      expect(parseMessage(JSON.stringify({ type: "resize", cols: 80, rows: bad }))).toBeNull();
    }
  });
});
