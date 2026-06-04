// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

/** How long to wait for DynamoDB to start answering before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** Delay between readiness probes. */
const READY_POLL_INTERVAL_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until DynamoDB answers a `ListTables` call, or throw after `timeoutMs`.
 * The integration suite races container startup otherwise — the first run can hit
 * DynamoDB Local before it accepts connections. Polling here makes the bootstrap
 * deterministic instead of relying on container-readiness timing, and it is a fast
 * no-op once DynamoDB is up (a single successful probe). Portable: works the same
 * locally and in CI, with no container health-check tooling required.
 */
export async function waitForDynamo(
  client: DynamoDBClient,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`DynamoDB did not become ready within ${timeoutMs.toString()}ms`, {
          cause: err,
        });
      }
      await delay(READY_POLL_INTERVAL_MS);
    }
  }
}
