// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { COST_SCOPE_TAG_KEY } from "@edd/config";
import { describe, expect, it } from "vitest";

import {
  getAwsAccountCostSummary,
  makeCachedAccountCostSummary,
  type CostExplorerReader,
} from "./aws-account-costs";

class FakeCostExplorer implements CostExplorerReader {
  readonly inputs: GetCostAndUsageCommandInput[] = [];

  constructor(private readonly amounts: readonly string[] = ["1.25", "2.50", "3.75"]) {}

  send(command: GetCostAndUsageCommand): Promise<GetCostAndUsageCommandOutput> {
    this.inputs.push(command.input);
    if (command.input.GroupBy !== undefined) {
      return Promise.resolve({
        $metadata: {},
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon Elastic Container Service"],
                Metrics: { UnblendedCost: { Amount: "10.30", Unit: "USD" } },
              },
              {
                Keys: ["AWS CodeBuild"],
                Metrics: { UnblendedCost: { Amount: "4.61", Unit: "USD" } },
              },
              {
                Keys: ["Free Service"],
                Metrics: { UnblendedCost: { Amount: "0", Unit: "USD" } },
              },
            ],
          },
        ],
      });
    }
    const amount = this.amounts[this.inputs.length - 1] ?? "0";
    return Promise.resolve({
      $metadata: {},
      ResultsByTime: [{ Total: { UnblendedCost: { Amount: amount, Unit: "USD" } } }],
    });
  }
}

describe("getAwsAccountCostSummary", () => {
  const usageOnlyFilter = { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } };
  const usageAndCostScopeFilter = {
    And: [usageOnlyFilter, { Tags: { Key: COST_SCOPE_TAG_KEY, Values: ["edd-alpha"] } }],
  };

  it("defaults to WHOLE-ACCOUNT usage (no tag filter) — the real bill", async () => {
    const client = new FakeCostExplorer();

    // Default scope: whole account. The tag-filtered path returns $0 when the
    // cost-allocation tag is unactivated, so the honest default is the account bill.
    const summary = await getAwsAccountCostSummary(new Date("2026-07-10T12:34:56.000Z"), client);

    expect(summary.generatedAt).toBe("2026-07-10T12:34:56.000Z");
    expect(summary.scope).toEqual({ kind: "account" });
    expect(summary.windows).toEqual([
      { label: "month to date", start: "2026-07-01", end: "2026-07-11", usd: 1.25 },
      { label: "last 7 days", start: "2026-07-04", end: "2026-07-11", usd: 2.5 },
      // CE DAILY granularity is UTC-day aligned: the tile queries the CURRENT UTC
      // day [today 00:00Z, tomorrow 00:00Z) and must be labelled as such — the old
      // "last 24h" label promised a rolling day this window does not deliver.
      { label: "today (UTC)", start: "2026-07-10", end: "2026-07-11", usd: 3.75 },
    ]);
    expect(summary.topServicesMonthToDate).toEqual([
      { service: "Amazon Elastic Container Service", usd: 10.3 },
      { service: "AWS CodeBuild", usd: 4.61 },
    ]);
    // Every query constrains to RECORD_TYPE=Usage but adds NO tag filter.
    expect(client.inputs.map((input) => input.Filter)).toEqual([
      usageOnlyFilter,
      usageOnlyFilter,
      usageOnlyFilter,
      usageOnlyFilter,
    ]);
  });

  it("scopes to the cost-allocation tag when a tag scope is supplied (shared-account mode)", async () => {
    const client = new FakeCostExplorer();
    const summary = await getAwsAccountCostSummary(new Date("2026-07-10T12:34:56.000Z"), client, {
      kind: "tag",
      value: "edd-alpha",
    });
    expect(summary.scope).toEqual({ kind: "tag", value: "edd-alpha" });
    expect(client.inputs.map((input) => input.Filter)).toEqual([
      usageAndCostScopeFilter,
      usageAndCostScopeFilter,
      usageAndCostScopeFilter,
      usageAndCostScopeFilter,
    ]);
  });

  it("fails loudly when Cost Explorer returns an invalid amount", async () => {
    const client = new FakeCostExplorer(["NaN"]);

    await expect(
      getAwsAccountCostSummary(new Date("2026-07-10T12:34:56.000Z"), client),
    ).rejects.toThrow("Cost Explorer day 0 returned invalid USD amount NaN");
  });
});

describe("makeCachedAccountCostSummary", () => {
  const SUMMARY_CALLS = 4; // 3 window queries + 1 service breakdown per load

  it("serves repeat reads within the TTL from cache — no further Cost Explorer calls", async () => {
    const client = new FakeCostExplorer();
    const ttlMs = 30 * 60 * 1000;
    const cached = makeCachedAccountCostSummary(client, ttlMs);

    // Time is passed in (§6.10): a burst of page renders inside the TTL —
    // including concurrent ones sharing the in-flight load — costs ONE load.
    const t0 = 1_000_000;
    const [a, b] = await Promise.all([cached(t0), cached(t0 + 1)]);
    await cached(t0 + ttlMs - 1);
    expect(client.inputs).toHaveLength(SUMMARY_CALLS);
    expect(b).toEqual(a);

    // Past the TTL the next read reloads (exactly one more batch of calls).
    await cached(t0 + ttlMs);
    expect(client.inputs).toHaveLength(2 * SUMMARY_CALLS);
  });

  it("does not cache a rejected load for the TTL (next read retries)", async () => {
    // Every window query returns an invalid amount, so each load attempt fails.
    const client = new FakeCostExplorer(Array<string>(16).fill("NaN"));
    const cached = makeCachedAccountCostSummary(client, 30 * 60 * 1000);
    await expect(cached(0)).rejects.toThrow("invalid USD amount");
    // The failure was not pinned: the very next call hits Cost Explorer again.
    await expect(cached(1)).rejects.toThrow("invalid USD amount");
    expect(client.inputs.length).toBeGreaterThan(1);
  });
});
