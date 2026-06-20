// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

import { TABLE } from "./index";
import { waitForDynamo } from "./wait";

/**
 * Single-table schema: one partition (PK/SK) plus two GSIs.
 *   GSI1 (byOwner)   — list a user's workspaces
 *   GSI2 (byState)   — reconciler scan by state, ordered by last activity
 * ElectroDB writes the PK/SK/GSI*PK/GSI*SK fields; this is the matching
 * CreateTable definition used to stand the table up in tests / migrations.
 */
export function tableDefinition(table = TABLE) {
  return {
    TableName: table,
    BillingMode: "PAY_PER_REQUEST" as const,
    AttributeDefinitions: [
      { AttributeName: "PK", AttributeType: "S" as const },
      { AttributeName: "SK", AttributeType: "S" as const },
      { AttributeName: "GSI1PK", AttributeType: "S" as const },
      { AttributeName: "GSI1SK", AttributeType: "S" as const },
      { AttributeName: "GSI2PK", AttributeType: "S" as const },
      { AttributeName: "GSI2SK", AttributeType: "S" as const },
    ],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" as const },
      { AttributeName: "SK", KeyType: "RANGE" as const },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "GSI1",
        KeySchema: [
          { AttributeName: "GSI1PK", KeyType: "HASH" as const },
          { AttributeName: "GSI1SK", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
      {
        IndexName: "GSI2",
        KeySchema: [
          { AttributeName: "GSI2PK", KeyType: "HASH" as const },
          { AttributeName: "GSI2SK", KeyType: "RANGE" as const },
        ],
        Projection: { ProjectionType: "ALL" as const },
      },
    ],
  };
}

/** Max seconds to wait for a newly-created table to reach ACTIVE. */
const TABLE_READY_WAIT_SECONDS = 60;

/** Create the table; no-op if it already exists. Waits for DynamoDB to be ready
 * first, so the integration bootstrap can't race a still-starting container. */
export async function ensureTable(client: DynamoDBClient, table = TABLE): Promise<void> {
  await waitForDynamo(client);
  try {
    await client.send(new CreateTableCommand(tableDefinition(table)));
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
  // On real AWS, CreateTable returns while the table is still CREATING — the next
  // write/query would throw ResourceNotFound until it's ACTIVE. Wait for ACTIVE (also
  // covers the already-exists path). DynamoDB Local returns ACTIVE immediately, so this
  // is a no-op there.
  await waitUntilTableExists(
    { client, maxWaitTime: TABLE_READY_WAIT_SECONDS },
    { TableName: table },
  );
}

/** Drop the table; no-op if absent. (Test helper.) Waits for readiness first so a
 * bootstrap that drops before it ensures is equally race-free. */
export async function dropTable(client: DynamoDBClient, table = TABLE): Promise<void> {
  await waitForDynamo(client);
  try {
    await client.send(new DeleteTableCommand({ TableName: table }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}
