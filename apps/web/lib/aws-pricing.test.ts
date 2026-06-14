// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseOnDemandUsd, parseUsageType } from "./aws-pricing";

// A representative AWS Price List `GetProducts` PriceList item (the real shape:
// product.attributes + terms.OnDemand.<sku>.priceDimensions.<rate>.pricePerUnit.USD).
const fargateVcpu = JSON.stringify({
  product: {
    productFamily: "Compute",
    attributes: { regionCode: "us-east-1", usagetype: "Fargate-vCPU-Hours:perCPU" },
  },
  terms: {
    OnDemand: {
      "ABCD.JRTCKXETXF": {
        priceDimensions: {
          "ABCD.JRTCKXETXF.6YS6EN2CT7": {
            unit: "hours",
            pricePerUnit: { USD: "0.0404800000" },
          },
        },
      },
    },
  },
});

describe("AWS Price List parsing", () => {
  it("extracts the on-demand USD price-per-unit", () => {
    expect(parseOnDemandUsd(fargateVcpu)).toBe(0.04048);
  });

  it("extracts the usagetype attribute (for Fargate vCPU/memory classification)", () => {
    expect(parseUsageType(fargateVcpu)).toBe("Fargate-vCPU-Hours:perCPU");
  });

  it("returns undefined for malformed / non-USD items", () => {
    expect(parseOnDemandUsd("not json")).toBeUndefined();
    expect(parseOnDemandUsd(JSON.stringify({ terms: {} }))).toBeUndefined();
    expect(
      parseOnDemandUsd(JSON.stringify({ terms: { OnDemand: { x: { priceDimensions: {} } } } })),
    ).toBeUndefined();
    expect(parseUsageType("not json")).toBeUndefined();
  });
});
