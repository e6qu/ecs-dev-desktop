// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { COST_SCOPE_TAG_KEY } from "@edd/config";
import { describe, expect, it } from "vitest";

import { getAwsAccountCostSummary, type CostExplorerReader } from "./aws-account-costs";

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
  const usageAndCostScopeFilter = {
    And: [
      { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } },
      { Tags: { Key: COST_SCOPE_TAG_KEY, Values: ["edd-alpha"] } },
    ],
  };

  it("queries deterministic UTC windows and sorts non-zero service costs", async () => {
    const client = new FakeCostExplorer();

    const summary = await getAwsAccountCostSummary(new Date("2026-07-10T12:34:56.000Z"), client);

    expect(summary.generatedAt).toBe("2026-07-10T12:34:56.000Z");
    expect(summary.costScope).toBe("edd-alpha");
    expect(summary.windows).toEqual([
      { label: "month to date", start: "2026-07-01", end: "2026-07-11", usd: 1.25 },
      { label: "last 7 days", start: "2026-07-04", end: "2026-07-11", usd: 2.5 },
      { label: "last 24h", start: "2026-07-10", end: "2026-07-11", usd: 3.75 },
    ]);
    expect(summary.topServicesMonthToDate).toEqual([
      { service: "Amazon Elastic Container Service", usd: 10.3 },
      { service: "AWS CodeBuild", usd: 4.61 },
    ]);
    expect(client.inputs.map((input) => input.TimePeriod)).toEqual([
      { Start: "2026-07-01", End: "2026-07-11" },
      { Start: "2026-07-04", End: "2026-07-11" },
      { Start: "2026-07-10", End: "2026-07-11" },
      { Start: "2026-07-01", End: "2026-07-11" },
    ]);
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
