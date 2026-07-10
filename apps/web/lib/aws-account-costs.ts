// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type DateInterval,
  type Expression,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { COST_SCOPE, COST_SCOPE_TAG_KEY } from "@edd/config";

const COST_EXPLORER_REGION = "us-east-1";
const USD_METRIC = "UnblendedCost";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  const oneDayStart = addDays(end, -1);
  const windows = [
    { label: "month to date", range: interval(monthStart, end) },
    { label: "last 7 days", range: interval(sevenDayStart, end) },
    { label: "last 24h", range: interval(oneDayStart, end) },
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
