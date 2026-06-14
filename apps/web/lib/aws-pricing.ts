// SPDX-License-Identifier: AGPL-3.0-or-later
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { DEFAULT_AWS_REGION, workspacePricing } from "@edd/config";
import type { Pricing } from "@edd/core";

/**
 * Region-accurate cost rates sourced LIVE from the AWS Price List API
 * (`pricing:GetProducts`) — so costing reflects AWS's own published on-demand
 * prices for the deployment's region, not a static table.
 *
 * The pricing *model* (Fargate vCPU-hr + GB-hr, EBS gp3 GB-mo, snapshot GB-mo) is
 * the same everywhere; this only supplies the numbers. It is **opt-in**
 * (`EDD_AWS_PRICING=1`) and best-effort: any rate the API doesn't yield falls back
 * to the configured `@edd/config` value (us-east-1 default, `EDD_PRICE_*`-
 * overridable), so a missing/denied API or an unexpected product shape never
 * mis-prices — it just uses the documented fallback. The Price List API has no
 * simulator, so the live path is exercised against real AWS (`e2e-aws`); the
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

/**
 * Best-effort: fetch the four rates for `region` from the Price List API. Returns
 * only the rates it could resolve; the caller fills the rest from config.
 */
async function fetchAwsPricing(region: string): Promise<Partial<Pricing>> {
  const client = new PricingClient({ region: PRICE_LIST_ENDPOINT_REGION });
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

/**
 * The cost rates in effect: live Price List rates for the deployment's region when
 * `EDD_AWS_PRICING=1`, each falling back to the configured rate; otherwise the
 * configured rates alone. Never throws — a failed live fetch degrades to config.
 */
export async function resolveWorkspacePricing(): Promise<Pricing> {
  const configured = workspacePricing();
  if (process.env[AWS_PRICING_ENV] !== "1") return configured;
  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
  const live = await fetchAwsPricing(region).catch((): Partial<Pricing> => ({}));
  return {
    fargateVcpuHourUsd: live.fargateVcpuHourUsd ?? configured.fargateVcpuHourUsd,
    fargateGbHourUsd: live.fargateGbHourUsd ?? configured.fargateGbHourUsd,
    ebsGbMonthUsd: live.ebsGbMonthUsd ?? configured.ebsGbMonthUsd,
    snapshotGbMonthUsd: live.snapshotGbMonthUsd ?? configured.snapshotGbMonthUsd,
  };
}
