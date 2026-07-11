// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type DateInterval,
  type Expression,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { COST_SCOPE, COST_SCOPE_TAG_KEY } from "@edd/config";

import { ttlCache } from "./ttl-cache";

const COST_EXPLORER_REGION = "us-east-1";
const USD_METRIC = "UnblendedCost";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long one fetched account-cost summary is served before Cost Explorer is
 * queried again. Cost Explorer charges per request (~$0.01) and its data only
 * refreshes a few times a day, while the admin costs page live-refreshes every
 * ~15s — uncached, ONE open tab was ~960 requests/hour (~$9.60/hr), forever. The
 * cache is process-shared, so total Cost Explorer spend stays at a few calls per
 * hour no matter how many admins/tabs hold the page open.
 */
const ACCOUNT_COST_SUMMARY_TTL_MS = 30 * 60 * 1000;

interface AccountCostWindow {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly usd: number;
}

interface AccountServiceCost {
  readonly service: string;
  readonly usd: number;
}

export interface AccountCostSummary {
  readonly generatedAt: string;
  readonly costScope: string;
  readonly windows: readonly AccountCostWindow[];
  readonly topServicesMonthToDate: readonly AccountServiceCost[];
}

export interface CostExplorerReader {
  send(command: GetCostAndUsageCommand): Promise<GetCostAndUsageCommandOutput>;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endExclusiveFor(now: Date): Date {
  return addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), 1);
}

function interval(start: Date, end: Date): DateInterval {
  return { Start: isoDate(start), End: isoDate(end) };
}

function parseUsd(label: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${label} missing USD amount`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} returned invalid USD amount ${value}`);
  }
  return parsed;
}

function requiredBoundary(label: string, value: string | undefined): string {
  if (value === undefined || value === "") throw new Error(`${label} missing Cost Explorer date`);
  return value;
}

function usageFilter(costScope: string): Expression {
  return {
    And: [
      { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } },
      { Tags: { Key: COST_SCOPE_TAG_KEY, Values: [costScope] } },
    ],
  };
}

async function costFor(
  client: CostExplorerReader,
  window: DateInterval,
  costScope: string,
): Promise<number> {
  const out = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: window,
      Granularity: "DAILY",
      Metrics: [USD_METRIC],
      Filter: usageFilter(costScope),
    }),
  );
  return (out.ResultsByTime ?? []).reduce(
    (sum, day, index) =>
      sum + parseUsd(`Cost Explorer day ${String(index)}`, day.Total?.[USD_METRIC]?.Amount),
    0,
  );
}

async function serviceCostsFor(
  client: CostExplorerReader,
  window: DateInterval,
  costScope: string,
): Promise<AccountServiceCost[]> {
  const out = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: window,
      Granularity: "MONTHLY",
      Metrics: [USD_METRIC],
      Filter: usageFilter(costScope),
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }),
  );
  return (out.ResultsByTime ?? [])
    .flatMap((period) =>
      (period.Groups ?? []).map((group): AccountServiceCost => {
        const service = group.Keys?.[0];
        if (service === undefined || service === "") {
          throw new Error("Cost Explorer service group missing service name");
        }
        return {
          service,
          usd: parseUsd(`Cost Explorer service ${service}`, group.Metrics?.[USD_METRIC]?.Amount),
        };
      }),
    )
    .filter((row) => row.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 10);
}

export async function getAwsAccountCostSummary(
  now: Date = new Date(),
  client: CostExplorerReader = new CostExplorerClient({ region: COST_EXPLORER_REGION }),
  costScope = COST_SCOPE,
): Promise<AccountCostSummary> {
  const end = endExclusiveFor(now);
  const monthStart = startOfUtcMonth(now);
  const sevenDayStart = addDays(end, -7);
  // Cost Explorer DAILY granularity is UTC-day aligned, so the tightest honest
  // window is the CURRENT UTC day [today 00:00Z, tomorrow 00:00Z) — labelled as
  // such. (A rolling "last 24h" is not expressible at this granularity; the old
  // "last 24h" label mislabelled exactly this window.)
  const todayStart = addDays(end, -1);
  const windows = [
    { label: "month to date", range: interval(monthStart, end) },
    { label: "last 7 days", range: interval(sevenDayStart, end) },
    { label: "today (UTC)", range: interval(todayStart, end) },
  ] as const;
  const priced = await Promise.all(
    windows.map(async (window) => ({
      label: window.label,
      start: requiredBoundary(`${window.label} start`, window.range.Start),
      end: requiredBoundary(`${window.label} end`, window.range.End),
      usd: await costFor(client, window.range, costScope),
    })),
  );
  return {
    generatedAt: now.toISOString(),
    costScope,
    windows: priced,
    topServicesMonthToDate: await serviceCostsFor(client, interval(monthStart, end), costScope),
  };
}

/** One Cost Explorer client per process — the SDK client is stateless and reusable;
 * constructing one per page render would churn sockets + credential resolution. */
let sharedClient: CostExplorerReader | undefined;
function defaultClient(): CostExplorerReader {
  sharedClient ??= new CostExplorerClient({ region: COST_EXPLORER_REGION });
  return sharedClient;
}

/**
 * Build a TTL-cached account-cost summary reader over `client`. Within the TTL
 * every caller (across requests, tabs, and admins — the cache lives in module
 * scope) shares one summary and NO Cost Explorer request is made; concurrent
 * cache misses share a single in-flight load. A rejected load is not cached, so
 * an error is retried on the next call rather than pinned for the TTL. Exported
 * so the cache behaviour is testable against a fake client with a pinned clock.
 */
export function makeCachedAccountCostSummary(
  client: CostExplorerReader,
  ttlMs: number = ACCOUNT_COST_SUMMARY_TTL_MS,
): (nowMs?: number) => Promise<AccountCostSummary> {
  const cached = ttlCache(() => getAwsAccountCostSummary(new Date(), client), ttlMs);
  return (nowMs = Date.now()) => cached(nowMs);
}

let cachedDefaultSummary: ((nowMs?: number) => Promise<AccountCostSummary>) | undefined;

/**
 * The process-shared, TTL-cached AWS account cost summary the admin costs page
 * renders. Bounds real Cost Explorer API calls (4 per refresh, ~$0.01 each) to a
 * few per hour regardless of how many tabs live-refresh the page; Cost Explorer
 * data itself only updates a few times a day, so a fresher read buys nothing.
 */
export function getCachedAwsAccountCostSummary(
  nowMs: number = Date.now(),
): Promise<AccountCostSummary> {
  cachedDefaultSummary ??= makeCachedAccountCostSummary(defaultClient());
  return cachedDefaultSummary(nowMs);
}
