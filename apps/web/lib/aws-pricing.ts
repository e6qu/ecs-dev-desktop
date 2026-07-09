// SPDX-License-Identifier: AGPL-3.0-or-later
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import {
  AWS_SDK_MAX_ATTEMPTS,
  AWS_SDK_RETRY_MODE,
  DEFAULT_AWS_REGION,
  workspacePricing,
} from "@edd/config";
import type { Pricing } from "@edd/core";

/**
 * Region-accurate cost rates sourced LIVE from the AWS Price List API
 * (`pricing:GetProducts`) — so costing reflects AWS's own published on-demand
 * prices for the deployment's region, not a static table.
 *
 * The pricing *model* (Fargate vCPU-hr + GB-hr, EBS gp3 GB-mo, snapshot GB-mo) is
 * the same everywhere; this only supplies the numbers. It is opt-in
 * (`EDD_AWS_PRICING=1`). When enabled, all four live rates are required: a
 * missing/denied Price List API call or an unexpected product shape fails the
 * report loudly instead of silently mis-pricing the fleet. The Price List API has
 * no simulator, so the live path is exercised against real AWS (`e2e-aws`); the
 * pure parser below is unit-tested against a recorded GetProducts response shape.
 */

/** Env flag enabling live Price List sourcing (off → configured rates only). */
const AWS_PRICING_ENV = "EDD_AWS_PRICING";
/** The Price List API is served only from these endpoints (it is a global service). */
const PRICE_LIST_ENDPOINT_REGION = "us-east-1";

/** Walk one level into an object value (first entry), typed-safely. */
function firstValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Object.values(value as Record<string, unknown>)[0];
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * Pure: extract the on-demand USD price-per-unit from one GetProducts PriceList
 * item (a JSON product). Returns undefined if the item is malformed or carries no
 * USD on-demand dimension. Shape:
 * `terms.OnDemand.<sku>.priceDimensions.<rate>.pricePerUnit.USD`.
 */
export function parseOnDemandUsd(item: string): number | undefined {
  let root: unknown;
  try {
    root = JSON.parse(item);
  } catch {
    return undefined;
  }
  const onDemand = prop(prop(root, "terms"), "OnDemand");
  const dimensions = prop(firstValue(onDemand), "priceDimensions");
  const usd = prop(prop(firstValue(dimensions), "pricePerUnit"), "USD");
  if (typeof usd !== "string") return undefined;
  const n = Number(usd);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Pure: the product's `usagetype` attribute (used to classify Fargate/EBS rows). */
export function parseUsageType(item: string): string | undefined {
  let root: unknown;
  try {
    root = JSON.parse(item);
  } catch {
    return undefined;
  }
  const usagetype = prop(prop(root, "product"), "attributes");
  const value = prop(usagetype, "usagetype");
  return typeof value === "string" ? value : undefined;
}

interface Filter {
  Type: "TERM_MATCH";
  Field: string;
  Value: string;
}

/** PriceList items arrive as JSON strings (older SDKs) or documents — normalize. */
function asJsonStrings(list: unknown): string[] {
  return Array.isArray(list)
    ? list.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    : [];
}

async function getProducts(
  client: PricingClient,
  serviceCode: string,
  filters: Filter[],
): Promise<string[]> {
  const out = await client.send(
    new GetProductsCommand({ ServiceCode: serviceCode, Filters: filters, MaxResults: 100 }),
  );
  return asJsonStrings(out.PriceList);
}

/** Fetch the four required rates for `region` from the Price List API. */
async function fetchAwsPricing(region: string): Promise<Partial<Pricing>> {
  const client = new PricingClient({
    region: PRICE_LIST_ENDPOINT_REGION,
    maxAttempts: AWS_SDK_MAX_ATTEMPTS,
    retryMode: AWS_SDK_RETRY_MODE,
  });
  const regionFilter: Filter = { Type: "TERM_MATCH", Field: "regionCode", Value: region };
  const out: { -readonly [K in keyof Pricing]?: Pricing[K] } = {};

  // Fargate: classify the region's AmazonECS rows by usagetype (vCPU vs memory).
  for (const item of await getProducts(client, "AmazonECS", [regionFilter])) {
    const usage = parseUsageType(item)?.toLowerCase() ?? "";
    const usd = parseOnDemandUsd(item);
    if (usd === undefined) continue;
    if (usage.includes("vcpu")) out.fargateVcpuHourUsd = usd;
    else if (usage.includes("gb")) out.fargateGbHourUsd = usd;
  }

  // EBS gp3 live volume storage (GB-month).
  for (const item of await getProducts(client, "AmazonEC2", [
    regionFilter,
    { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage" },
    { Type: "TERM_MATCH", Field: "volumeApiName", Value: "gp3" },
  ])) {
    if (!(parseUsageType(item)?.toLowerCase() ?? "").includes("volumeusage")) continue;
    const usd = parseOnDemandUsd(item);
    if (usd !== undefined) out.ebsGbMonthUsd = usd;
  }

  // EBS snapshot storage (GB-month, standard tier).
  for (const item of await getProducts(client, "AmazonEC2", [
    regionFilter,
    { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage Snapshot" },
  ])) {
    if (!(parseUsageType(item)?.toLowerCase() ?? "").includes("snapshotusage")) continue;
    const usd = parseOnDemandUsd(item);
    if (usd !== undefined) out.snapshotGbMonthUsd = usd;
  }

  return out;
}

export function requireLivePricing(region: string, live: Partial<Pricing>): Pricing {
  const { fargateVcpuHourUsd, fargateGbHourUsd, ebsGbMonthUsd, snapshotGbMonthUsd } = live;
  const missing: string[] = [];
  if (fargateVcpuHourUsd === undefined) missing.push("fargateVcpuHourUsd");
  if (fargateGbHourUsd === undefined) missing.push("fargateGbHourUsd");
  if (ebsGbMonthUsd === undefined) missing.push("ebsGbMonthUsd");
  if (snapshotGbMonthUsd === undefined) missing.push("snapshotGbMonthUsd");
  if (missing.length > 0) {
    throw new Error(
      `AWS Price List did not return required ${region} rate(s): ${missing.join(", ")}`,
    );
  }
  if (
    fargateVcpuHourUsd === undefined ||
    fargateGbHourUsd === undefined ||
    ebsGbMonthUsd === undefined ||
    snapshotGbMonthUsd === undefined
  ) {
    throw new Error("unreachable: live pricing guard failed to narrow all rates");
  }
  return {
    fargateVcpuHourUsd,
    fargateGbHourUsd,
    ebsGbMonthUsd,
    snapshotGbMonthUsd,
  };
}

/**
 * The cost rates in effect: configured rates unless `EDD_AWS_PRICING=1`; when
 * live AWS pricing is enabled, every required live rate must resolve or the
 * caller receives a loud configuration/permission/product-shape error.
 */
export async function resolveWorkspacePricing(): Promise<Pricing> {
  if (process.env[AWS_PRICING_ENV] !== "1") return workspacePricing();
  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
  return requireLivePricing(region, await fetchAwsPricing(region));
}
