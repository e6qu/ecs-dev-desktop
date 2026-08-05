// SPDX-License-Identifier: AGPL-3.0-or-later
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { AWS_SDK_MAX_ATTEMPTS, AWS_SDK_RETRY_MODE, awsRegion } from "@edd/config";

/**
 * Build a DynamoDB client. The endpoint coordinate is `AWS_ENDPOINT_URL` ONLY — the test
 * tiers set it (from the `@edd/config` `dynamodb.endpoint` default, the sockerless sim at
 * :4566) and the `pnpm dev` loop sets it (the sim). When it is set the client points
 * there with dummy credentials; when UNSET (e.g. real cloud) the client deliberately falls
 * through to the ambient AWS environment — so it must not silently default to the sim.
 *
 * Uses the platform's standard retry policy (adaptive, 6 attempts) — this is the
 * highest-traffic, most-contended client (every optimistic-concurrency write and
 * `writeTransaction` at 200+ scale), exactly where on-demand burst throttling and
 * `TransactionConflict` cancellations are best absorbed by adaptive backoff.
 */
export function createDynamoClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: awsRegion(),
    maxAttempts: AWS_SDK_MAX_ATTEMPTS,
    retryMode: AWS_SDK_RETRY_MODE,
  });
}
