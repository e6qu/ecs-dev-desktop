// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type DateInterval,
  type Expression,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { COST_SCOPE, COST_SCOPE_ENABLED, COST_SCOPE_TAG_KEY } from "@edd/config";

import { ttlCache } from "./ttl-cache";

const COST_EXPLORER_REGION = "us-east-1";
/**
 * `UnblendedCost` (NOT `NetUnblendedCost`/`NetAmortizedCost`) + a `RECORD_TYPE=Usage`
 * filter is deliberately the pure **on-demand** cost: it excludes credits and refunds
 * (separate record types — this is why the pre-fix tag-scoped view read $0 while the account
 * really spent ~$50/mo, offset by credits), and it excludes reservation/Savings-Plan discounts
 * (RI/SP-covered usage is `DiscountedUsage`/`SavingsPlanCoveredUsage`, not `Usage`) and tax.
 * So the reported figure is what EDD costs at published on-demand rates with no discounts of
 * any kind — the honest run-rate — matching the product requirement. The UI states this.
 */
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
  /** How the summary was scoped: the whole account, or filtered to a cost-scope tag. */
  readonly scope: { readonly kind: "account" } | { readonly kind: "tag"; readonly value: string };
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

/** How the account-cost summary is scoped. `account` = the whole AWS account's usage
 * (the real bill; correct for a dedicated EDD account). `tag` = filtered to the
 * `edd:cost-scope` cost-allocation tag (shared-account mode — requires the tag activated). */
export type AccountScope =
  | { readonly kind: "account" }
  | { readonly kind: "tag"; readonly value: string };

/** The Cost Explorer filter for a scope. Always constrains to `RECORD_TYPE=Usage` (so
 * credits/refunds don't net real usage to ~$0 and hide the true run-rate); adds the
 * cost-scope tag only in `tag` mode. */
function usageFilter(scope: AccountScope): Expression {
  const usage: Expression = { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } };
  if (scope.kind === "account") return usage;
  return { And: [usage, { Tags: { Key: COST_SCOPE_TAG_KEY, Values: [scope.value] } }] };
}

async function costFor(
  client: CostExplorerReader,
  window: DateInterval,
  scope: AccountScope,
): Promise<number> {
  const out = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: window,
      Granularity: "DAILY",
      Metrics: [USD_METRIC],
      Filter: usageFilter(scope),
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
  scope: AccountScope,
): Promise<AccountServiceCost[]> {
  const out = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: window,
      Granularity: "MONTHLY",
      Metrics: [USD_METRIC],
      Filter: usageFilter(scope),
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

/** The configured scope: whole account by default; the cost-scope tag only when an
 * operator opts in (shared-account mode). See {@link COST_SCOPE_ENABLED}. */
function configuredScope(): AccountScope {
  return COST_SCOPE_ENABLED ? { kind: "tag", value: COST_SCOPE } : { kind: "account" };
}

export async function getAwsAccountCostSummary(
  now: Date = new Date(),
  client: CostExplorerReader = new CostExplorerClient({ region: COST_EXPLORER_REGION }),
  scope: AccountScope = configuredScope(),
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
      usd: await costFor(client, window.range, scope),
    })),
  );
  return {
    generatedAt: now.toISOString(),
    scope,
    windows: priced,
    topServicesMonthToDate: await serviceCostsFor(client, interval(monthStart, end), scope),
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
