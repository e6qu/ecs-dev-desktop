// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DescribeTableCommand,
  type DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import type { ComponentHealth } from "@edd/core";

/**
 * Dependency health for the single table — a `DescribeTable` ping for the admin
 * Health board. `ok` when ACTIVE, `degraded` when present but not ACTIVE or missing,
 * `down` when DynamoDB is unreachable.
 */
export async function pingTable(client: DynamoDBClient, table: string): Promise<ComponentHealth> {
  try {
    const out = await client.send(new DescribeTableCommand({ TableName: table }));
    const status = out.Table?.TableStatus;
    return {
      component: "dynamodb",
      status: status === "ACTIVE" ? "ok" : "degraded",
      detail: `table '${table}' ${status ?? "status unknown"}`,
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return { component: "dynamodb", status: "degraded", detail: `table '${table}' not found` };
    }
    return {
      component: "dynamodb",
      status: "down",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
