// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  GetProductsCommand,
  PricingClient,
  type GetProductsCommandOutput,
} from "@aws-sdk/client-pricing";
import {
  AWS_SDK_MAX_ATTEMPTS,
  AWS_SDK_RETRY_MODE,
  DEFAULT_AWS_REGION,
  workspacePricing,
} from "@edd/config";
import type { Pricing } from "@edd/core";

import { ttlCache } from "./ttl-cache";

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
 * pure parsing/classification below is unit-tested against recorded GetProducts
 * response shapes.
 */

/** Env flag enabling live Price List sourcing (off → configured rates only). */
const AWS_PRICING_ENV = "EDD_AWS_PRICING";
/** The Price List API is served only from these endpoints (it is a global service). */
const PRICE_LIST_ENDPOINT_REGION = "us-east-1";
/** GetProducts page size (its documented maximum); `NextToken` pages beyond it. */
const GET_PRODUCTS_PAGE_SIZE = 100;

/**
 * The exact `usagetype` values (region prefix aside — see {@link usageTypeMatches})
 * of the rates the cost model bills. Loose substring matching is NOT safe here:
 * `Fargate-ARM-vCPU-Hours:perCPU`, `Fargate-Windows-vCPU-Hours:perCPU` and
 * `Fargate-EphemeralStorage-GB-Hours` all contain "vcpu"/"gb" and bill wildly
 * different rates (ephemeral storage is ~40x cheaper than memory), so whichever
 * row the API happened to return last used to win.
 */
const FARGATE_VCPU_USAGE = "Fargate-vCPU-Hours:perCPU";
const FARGATE_MEMORY_USAGE = "Fargate-GB-Hours";
const EBS_GP3_VOLUME_USAGE = "EBS:VolumeUsage.gp3";
const EBS_SNAPSHOT_USAGE = "EBS:SnapshotUsage";

/** Usage types outside us-east-1 carry a region prefix token (`USE2-`, `EUC1-`,
 * `APS1-`, …): uppercase alphanumerics followed by a dash. */
const REGION_PREFIX = /^[A-Z0-9]+$/;

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

/**
 * Pure: whether a Price List `usagetype` is EXACTLY `expected`, allowing only the
 * optional region prefix AWS prepends outside us-east-1 (`USE2-Fargate-vCPU-Hours:perCPU`).
 * This is deliberately not a substring test — ARM/Windows/EphemeralStorage variants
 * embed the same tokens but are different (much cheaper/dearer) SKUs.
 */
export function usageTypeMatches(usageType: string, expected: string): boolean {
  if (usageType === expected) return true;
  if (!usageType.endsWith(`-${expected}`)) return false;
  const prefix = usageType.slice(0, usageType.length - expected.length - 1);
  return REGION_PREFIX.test(prefix);
}

/**
 * Pure: the single on-demand USD rate among `items` whose `usagetype` exactly
 * matches `expected` (Linux/x86 shape). Returns undefined when no row matches —
 * {@link requireLivePricing} then names the missing rate loudly — and throws when
 * two rows claim the same usage type at DIFFERENT prices (a classification bug we
 * must never resolve by silently picking one).
 */
export function pickExactRate(items: readonly string[], expected: string): number | undefined {
  let rate: number | undefined;
  for (const item of items) {
    const usage = parseUsageType(item);
    if (usage === undefined || !usageTypeMatches(usage, expected)) continue;
    const usd = parseOnDemandUsd(item);
    if (usd === undefined) continue;
    if (rate !== undefined && rate !== usd) {
      throw new Error(
        `AWS Price List returned conflicting on-demand rates for usage type ${expected}: ` +
          `${String(rate)} and ${String(usd)} USD`,
      );
    }
    rate = usd;
  }
  return rate;
}

interface Filter {
  Type: "TERM_MATCH";
  Field: string;
  Value: string;
}

/** The one Price List call this module makes — injectable so the pagination and
 * classification logic is unit-testable against recorded product rows. */
export interface PricingReader {
  send(command: GetProductsCommand): Promise<GetProductsCommandOutput>;
}

/** PriceList items arrive as JSON strings (older SDKs) or documents — normalize. */
function asJsonStrings(list: unknown): string[] {
  return Array.isArray(list)
    ? list.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    : [];
}

/** Every product for the filters, following `NextToken` across ALL pages — a
 * single page (100 items) can drop the wanted x86 rows behind ARM/Windows ones. */
async function getProducts(
  client: PricingReader,
  serviceCode: string,
  filters: Filter[],
): Promise<string[]> {
  const items: string[] = [];
  let nextToken: string | undefined;
  do {
    const out = await client.send(
      new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: filters,
        MaxResults: GET_PRODUCTS_PAGE_SIZE,
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
    );
    items.push(...asJsonStrings(out.PriceList));
    nextToken = out.NextToken;
  } while (nextToken !== undefined);
  return items;
}

/** Fetch the four required rates for `region` from the Price List API. Exported
 * (with the injectable reader) so pagination + SKU selection are testable. */
export async function fetchAwsPricing(
  region: string,
  client: PricingReader,
): Promise<Partial<Pricing>> {
  const regionFilter: Filter = { Type: "TERM_MATCH", Field: "regionCode", Value: region };
  const out: { -readonly [K in keyof Pricing]?: Pricing[K] } = {};

  // Fargate: the region's AmazonECS rows include Linux/x86, ARM, Windows and
  // ephemeral-storage SKUs — select the exact Linux/x86 vCPU + memory usage types.
  const fargate = await getProducts(client, "AmazonECS", [regionFilter]);
  const vcpu = pickExactRate(fargate, FARGATE_VCPU_USAGE);
  if (vcpu !== undefined) out.fargateVcpuHourUsd = vcpu;
  const memory = pickExactRate(fargate, FARGATE_MEMORY_USAGE);
  if (memory !== undefined) out.fargateGbHourUsd = memory;

  // EBS gp3 live volume storage (GB-month).
  const volumes = await getProducts(client, "AmazonEC2", [
    regionFilter,
    { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage" },
    { Type: "TERM_MATCH", Field: "volumeApiName", Value: "gp3" },
  ]);
  const volume = pickExactRate(volumes, EBS_GP3_VOLUME_USAGE);
  if (volume !== undefined) out.ebsGbMonthUsd = volume;

  // EBS snapshot storage (GB-month, standard tier — not archive/FSR variants).
  const snapshots = await getProducts(client, "AmazonEC2", [
    regionFilter,
    { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage Snapshot" },
  ]);
  const snapshot = pickExactRate(snapshots, EBS_SNAPSHOT_USAGE);
  if (snapshot !== undefined) out.snapshotGbMonthUsd = snapshot;

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

/** One Price List client per process — `resolveWorkspacePricing` runs per report,
 * and the client is stateless/thread-safe, so re-constructing it per call would
 * only churn sockets and credential resolution. */
let sharedPricingClient: PricingClient | undefined;
function defaultPricingClient(): PricingClient {
  sharedPricingClient ??= new PricingClient({
    region: PRICE_LIST_ENDPOINT_REGION,
    maxAttempts: AWS_SDK_MAX_ATTEMPTS,
    retryMode: AWS_SDK_RETRY_MODE,
  });
  return sharedPricingClient;
}

/** Resolve the rates once (uncached): configured rates unless `EDD_AWS_PRICING=1`, else the
 * live Price List rates (all four required, or a loud error). Wrapped by the TTL cache below. */
async function resolveWorkspacePricingUncached(): Promise<Pricing> {
  if (process.env[AWS_PRICING_ENV] !== "1") return workspacePricing();
  const region = process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
  return requireLivePricing(region, await fetchAwsPricing(region, defaultPricingClient()));
}

/** How long a resolved pricing snapshot is served before re-resolving. AWS on-demand
 * prices change at most monthly, but the admin Costs page live-refreshes every ~15s and
 * the reconciler prices every sweep — so with `EDD_AWS_PRICING=1` the uncached path made
 * ~4 paginated Price List `GetProducts` calls per refresh per viewer. A multi-hour TTL
 * collapses that to a handful of calls/day while staying far fresher than prices change. */
const PRICING_TTL_MS = 6 * 60 * 60 * 1000;
const cachedPricing = ttlCache<Pricing>(resolveWorkspacePricingUncached, PRICING_TTL_MS);

/**
 * The cost rates in effect: configured rates unless `EDD_AWS_PRICING=1`; when live AWS
 * pricing is enabled, every required live rate must resolve or the caller receives a loud
 * configuration/permission/product-shape error. Process-shared TTL-cached (see
 * {@link PRICING_TTL_MS}) so a burst of reports/refreshes shares one resolution; a failed
 * live resolution is not cached (the next call retries).
 */
export function resolveWorkspacePricing(nowMs: number = Date.now()): Promise<Pricing> {
  return cachedPricing(nowMs);
}
