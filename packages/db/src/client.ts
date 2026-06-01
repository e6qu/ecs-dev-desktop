// SPDX-License-Identifier: AGPL-3.0-or-later
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

/**
 * Build a DynamoDB client. When `DYNAMODB_ENDPOINT` is set (DynamoDB Local in
 * the Tier-2 harness, or a sockerless sim later) it points there with dummy
 * credentials; otherwise it uses the ambient AWS environment.
 */
export function createDynamoClient(): DynamoDBClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  return new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });
}
