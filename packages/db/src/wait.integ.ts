// SPDX-License-Identifier: AGPL-3.0-or-later
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { createDynamoClient, dynamodbLocal, waitForDynamo } from "./index";

process.env.DYNAMODB_ENDPOINT ??= dynamodbLocal.endpoint;

describe("waitForDynamo", () => {
  it("resolves once DynamoDB Local is answering", async () => {
    await expect(waitForDynamo(createDynamoClient())).resolves.toBeUndefined();
  });

  it("throws after the timeout when DynamoDB is unreachable", async () => {
    // Nothing listens on :1; each probe fails fast (maxAttempts 1, no SDK retry),
    // so the deadline is reached deterministically.
    const dead = new DynamoDBClient({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      maxAttempts: 1,
      credentials: { accessKeyId: "x", secretAccessKey: "x" },
    });
    await expect(waitForDynamo(dead, 300)).rejects.toThrow(/did not become ready/);
  });
});
