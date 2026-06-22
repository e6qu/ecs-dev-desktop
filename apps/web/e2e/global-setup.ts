// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

/**
 * Playwright global setup: stand up a fresh single-table DynamoDB Local table for
 * the run. Uses the raw AWS SDK (not `@edd/db`) because Playwright's loader does
 * not transpile the workspace TypeScript packages; the schema mirrors
 * `packages/db/src/table.ts` (PK/SK + GSI1 + GSI2). The catalog + workspaces are
 * then exercised through the running app over this table.
 */
const TABLE = process.env.DYNAMODB_TABLE ?? "ecs-dev-desktop-pw";
const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:4566";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default async function globalSetup(): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: TABLE }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  const create = new CreateTableCommand({
    TableName: TABLE,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
      { AttributeName: "GSI1PK", AttributeType: "S" },
      { AttributeName: "GSI1SK", AttributeType: "S" },
      { AttributeName: "GSI2PK", AttributeType: "S" },
      { AttributeName: "GSI2SK", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "GSI1",
        KeySchema: [
          { AttributeName: "GSI1PK", KeyType: "HASH" },
          { AttributeName: "GSI1SK", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "GSI2",
        KeySchema: [
          { AttributeName: "GSI2PK", KeyType: "HASH" },
          { AttributeName: "GSI2SK", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });

  // Retry create — a just-deleted table may briefly linger on DynamoDB Local.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(create);
      return;
    } catch (err) {
      if (err instanceof ResourceInUseException && attempt < 10) {
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
}
