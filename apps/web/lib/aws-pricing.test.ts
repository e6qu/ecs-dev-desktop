// SPDX-License-Identifier: AGPL-3.0-or-later
import { GetProductsCommand, type GetProductsCommandOutput } from "@aws-sdk/client-pricing";
import { describe, expect, it } from "vitest";

import {
  fetchAwsPricing,
  parseOnDemandUsd,
  parseUsageType,
  pickExactRate,
  requireLivePricing,
  usageTypeMatches,
  type PricingReader,
} from "./aws-pricing";

// A representative AWS Price List `GetProducts` PriceList item (the real shape:
// product.attributes + terms.OnDemand.<sku>.priceDimensions.<rate>.pricePerUnit.USD).
function priceItem(usagetype: string, usd: string): string {
  return JSON.stringify({
    product: {
      productFamily: "Compute",
      attributes: { regionCode: "us-east-1", usagetype },
    },
    terms: {
      OnDemand: {
        "ABCD.JRTCKXETXF": {
          priceDimensions: {
            "ABCD.JRTCKXETXF.6YS6EN2CT7": {
              unit: "hours",
              pricePerUnit: { USD: usd },
            },
          },
        },
      },
    },
  });
}

const fargateVcpu = priceItem("Fargate-vCPU-Hours:perCPU", "0.0404800000");

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

describe("usageTypeMatches", () => {
  it("matches the exact usage type, with or without a region prefix", () => {
    expect(usageTypeMatches("Fargate-vCPU-Hours:perCPU", "Fargate-vCPU-Hours:perCPU")).toBe(true);
    expect(usageTypeMatches("USE2-Fargate-vCPU-Hours:perCPU", "Fargate-vCPU-Hours:perCPU")).toBe(
      true,
    );
    expect(usageTypeMatches("EUC1-Fargate-GB-Hours", "Fargate-GB-Hours")).toBe(true);
    expect(usageTypeMatches("APS1-EBS:SnapshotUsage", "EBS:SnapshotUsage")).toBe(true);
  });

  it("rejects ARM, Windows, and ephemeral-storage variants (no substring matching)", () => {
    expect(usageTypeMatches("Fargate-ARM-vCPU-Hours:perCPU", "Fargate-vCPU-Hours:perCPU")).toBe(
      false,
    );
    expect(usageTypeMatches("Fargate-Windows-vCPU-Hours:perCPU", "Fargate-vCPU-Hours:perCPU")).toBe(
      false,
    );
    expect(usageTypeMatches("Fargate-ARM-GB-Hours", "Fargate-GB-Hours")).toBe(false);
    expect(usageTypeMatches("Fargate-EphemeralStorage-GB-Hours", "Fargate-GB-Hours")).toBe(false);
    expect(usageTypeMatches("EBS:SnapshotUsageUnderBilling", "EBS:SnapshotUsage")).toBe(false);
    // A non-region prefix (lowercase / structured) is not a region code.
    expect(usageTypeMatches("weird-Fargate-GB-Hours", "Fargate-GB-Hours")).toBe(false);
  });
});

describe("pickExactRate", () => {
  // The real hazard: AmazonECS returns x86, ARM, Windows and ephemeral-storage rows
  // together, and last-match-wins used to let whichever row arrived last overwrite
  // the true rate (ephemeral storage is ~40x cheaper than memory).
  const mixedFargate = [
    priceItem("Fargate-ARM-vCPU-Hours:perCPU", "0.0323680000"),
    priceItem("Fargate-Windows-vCPU-Hours:perCPU", "0.0910400000"),
    priceItem("Fargate-vCPU-Hours:perCPU", "0.0404800000"),
    priceItem("Fargate-EphemeralStorage-GB-Hours", "0.0001110000"),
    priceItem("Fargate-ARM-GB-Hours", "0.0035560000"),
    priceItem("Fargate-GB-Hours", "0.0044450000"),
    priceItem("Fargate-Windows-GB-Hours", "0.0100000000"),
  ];

  it("selects the exact Linux/x86 rate from a mixed product list, regardless of row order", () => {
    expect(pickExactRate(mixedFargate, "Fargate-vCPU-Hours:perCPU")).toBe(0.04048);
    expect(pickExactRate(mixedFargate, "Fargate-GB-Hours")).toBe(0.004445);
    expect(pickExactRate([...mixedFargate].reverse(), "Fargate-GB-Hours")).toBe(0.004445);
  });

  it("returns undefined when the exact row is absent (missing rate fails loud downstream)", () => {
    const noX86 = mixedFargate.filter((i) => parseUsageType(i) !== "Fargate-vCPU-Hours:perCPU");
    expect(pickExactRate(noX86, "Fargate-vCPU-Hours:perCPU")).toBeUndefined();
    expect(() =>
      requireLivePricing("us-east-1", {
        fargateGbHourUsd: 0.004445,
        ebsGbMonthUsd: 0.08,
        snapshotGbMonthUsd: 0.05,
        ...(pickExactRate(noX86, "Fargate-vCPU-Hours:perCPU") === undefined
          ? {}
          : { fargateVcpuHourUsd: pickExactRate(noX86, "Fargate-vCPU-Hours:perCPU") }),
      }),
    ).toThrow("AWS Price List did not return required us-east-1 rate(s): fargateVcpuHourUsd");
  });

  it("fails loud on two rows claiming the same usage type at different prices", () => {
    const conflicting = [
      priceItem("Fargate-GB-Hours", "0.0044450000"),
      priceItem("Fargate-GB-Hours", "0.0001110000"),
    ];
    expect(() => pickExactRate(conflicting, "Fargate-GB-Hours")).toThrow(
      "conflicting on-demand rates for usage type Fargate-GB-Hours",
    );
  });

  it("tolerates duplicate rows agreeing on the same price", () => {
    const duplicated = [
      priceItem("Fargate-GB-Hours", "0.0044450000"),
      priceItem("Fargate-GB-Hours", "0.0044450000"),
    ];
    expect(pickExactRate(duplicated, "Fargate-GB-Hours")).toBe(0.004445);
  });
});

/** A fake Price List endpoint serving canned pages per service, requiring the
 * NextToken chain to be followed to see anything beyond the first page. */
class FakePricing implements PricingReader {
  readonly calls: { serviceCode?: string; nextToken?: string }[] = [];

  constructor(private readonly pages: Record<string, string[][]>) {}

  send(command: GetProductsCommand): Promise<GetProductsCommandOutput> {
    const { ServiceCode, NextToken } = command.input;
    this.calls.push({
      ...(ServiceCode === undefined ? {} : { serviceCode: ServiceCode }),
      ...(NextToken === undefined ? {} : { nextToken: NextToken }),
    });
    const familyFilter = command.input.Filters?.find((f) => f.Field === "productFamily")?.Value;
    const key = `${ServiceCode ?? ""}:${familyFilter ?? ""}`;
    const pages = this.pages[key] ?? [[]];
    const index = NextToken === undefined ? 0 : Number(NextToken);
    const page = pages[index] ?? [];
    const next = index + 1 < pages.length ? String(index + 1) : undefined;
    return Promise.resolve({
      $metadata: {},
      PriceList: page,
      ...(next === undefined ? {} : { NextToken: next }),
    });
  }
}

describe("fetchAwsPricing", () => {
  it("follows NextToken across pages — an x86 row on a later page is still found", async () => {
    const client = new FakePricing({
      // Page 1 holds only ARM/Windows/ephemeral rows; the wanted x86 rows are on
      // page 2 — the unpaginated fetch used to drop them entirely.
      "AmazonECS:": [
        [
          priceItem("Fargate-ARM-vCPU-Hours:perCPU", "0.0323680000"),
          priceItem("Fargate-EphemeralStorage-GB-Hours", "0.0001110000"),
          priceItem("Fargate-Windows-GB-Hours", "0.0100000000"),
        ],
        [
          priceItem("Fargate-vCPU-Hours:perCPU", "0.0404800000"),
          priceItem("Fargate-GB-Hours", "0.0044450000"),
        ],
      ],
      "AmazonEC2:Storage": [[priceItem("EBS:VolumeUsage.gp3", "0.0800000000")]],
      "AmazonEC2:Storage Snapshot": [
        [priceItem("EBS:SnapshotArchiveStorage", "0.0125000000")],
        [priceItem("EBS:SnapshotUsage", "0.0500000000")],
      ],
    });

    const live = await fetchAwsPricing("us-east-1", client);
    expect(requireLivePricing("us-east-1", live)).toEqual({
      fargateVcpuHourUsd: 0.04048,
      fargateGbHourUsd: 0.004445,
      ebsGbMonthUsd: 0.08,
      snapshotGbMonthUsd: 0.05,
    });
    // The ECS listing and the snapshot listing each required a second page.
    expect(client.calls.filter((c) => c.serviceCode === "AmazonECS")).toHaveLength(2);
    expect(client.calls.filter((c) => c.nextToken !== undefined)).toHaveLength(2);
  });

  it("omits (never substitutes) a rate whose exact x86 row is missing", async () => {
    const client = new FakePricing({
      // ARM + ephemeral only: nothing here may masquerade as the x86 rates.
      "AmazonECS:": [
        [
          priceItem("Fargate-ARM-vCPU-Hours:perCPU", "0.0323680000"),
          priceItem("Fargate-EphemeralStorage-GB-Hours", "0.0001110000"),
        ],
      ],
      "AmazonEC2:Storage": [[priceItem("EBS:VolumeUsage.gp3", "0.0800000000")]],
      "AmazonEC2:Storage Snapshot": [[priceItem("EBS:SnapshotUsage", "0.0500000000")]],
    });

    const live = await fetchAwsPricing("us-east-1", client);
    expect(live.fargateVcpuHourUsd).toBeUndefined();
    expect(live.fargateGbHourUsd).toBeUndefined();
    expect(() => requireLivePricing("us-east-1", live)).toThrow(
      "AWS Price List did not return required us-east-1 rate(s): fargateVcpuHourUsd, fargateGbHourUsd",
    );
  });
});

describe("requireLivePricing", () => {
  it("fails loudly when AWS Price List omitted any required live rate", () => {
    expect(() =>
      requireLivePricing("eu-west-1", {
        fargateVcpuHourUsd: 0.04048,
        fargateGbHourUsd: 0.004445,
        ebsGbMonthUsd: 0.08,
      }),
    ).toThrow("AWS Price List did not return required eu-west-1 rate(s): snapshotGbMonthUsd");
  });

  it("returns the complete live AWS pricing set", () => {
    expect(
      requireLivePricing("eu-west-1", {
        fargateVcpuHourUsd: 0.04048,
        fargateGbHourUsd: 0.004445,
        ebsGbMonthUsd: 0.08,
        snapshotGbMonthUsd: 0.05,
      }),
    ).toEqual({
      fargateVcpuHourUsd: 0.04048,
      fargateGbHourUsd: 0.004445,
      ebsGbMonthUsd: 0.08,
      snapshotGbMonthUsd: 0.05,
    });
  });
});
