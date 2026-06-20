// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseOnDemandUsd, parseUsageType } from "./aws-pricing";

// Both parsers consume one AWS Price List `GetProducts` item — an externally
// supplied JSON string — so they must be total over arbitrary/adversarial input:
// never throw, and (for `parseOnDemandUsd`) never yield a NaN/Infinity/negative
// price that would silently mis-price a workspace.

const arbitraryItem = fc.oneof(
  fc.string(),
  // JSON-shaped values stringified, including the structurally-relevant nesting.
  fc.json(),
  fc.jsonValue().map((v) => JSON.stringify(v)),
  // Items shaped like the real contract but with adversarial leaf values.
  fc
    .record({
      product: fc.record({ attributes: fc.dictionary(fc.string(), fc.anything()) }),
      terms: fc.record({
        OnDemand: fc.dictionary(
          fc.string(),
          fc.record({
            priceDimensions: fc.dictionary(
              fc.string(),
              fc.record({ pricePerUnit: fc.dictionary(fc.string(), fc.anything()) }),
            ),
          }),
        ),
      }),
    })
    .map((v) => JSON.stringify(v)),
);

describe("aws-pricing parsers (property)", () => {
  it("parseOnDemandUsd never throws and returns undefined or a finite non-negative number", () => {
    fc.assert(
      fc.property(arbitraryItem, (item) => {
        const usd = parseOnDemandUsd(item);
        if (usd === undefined) return;
        expect(Number.isFinite(usd)).toBe(true);
        expect(Number.isNaN(usd)).toBe(false);
        expect(usd).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("parseUsageType never throws and returns a string or undefined", () => {
    fc.assert(
      fc.property(arbitraryItem, (item) => {
        const usage = parseUsageType(item);
        expect(usage === undefined || typeof usage === "string").toBe(true);
      }),
    );
  });

  it("round-trips a well-formed USD on-demand rate", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
        fc.string(),
        (rate, usagetype) => {
          const item = JSON.stringify({
            product: { attributes: { usagetype } },
            terms: {
              OnDemand: {
                sku: { priceDimensions: { d: { pricePerUnit: { USD: String(rate) } } } },
              },
            },
          });
          expect(parseOnDemandUsd(item)).toBeCloseTo(rate, 6);
          expect(parseUsageType(item)).toBe(usagetype);
        },
      ),
    );
  });
});
