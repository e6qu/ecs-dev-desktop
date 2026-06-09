// SPDX-License-Identifier: AGPL-3.0-or-later
import { awsSim, DEFAULT_AWS_REGION } from "@edd/config";

interface AwsSimCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AwsSimClientConfig {
  region: string;
  endpoint: string;
  credentials: AwsSimCredentials;
}

const DEFAULT_CREDENTIALS: AwsSimCredentials = {
  accessKeyId: "test",
  secretAccessKey: "test",
};

export function configureAwsSimEnv(): void {
  process.env.AWS_ENDPOINT_URL ??= awsSim.endpoint;
  process.env.AWS_REGION ??= DEFAULT_AWS_REGION;
  process.env.AWS_ACCESS_KEY_ID ??= DEFAULT_CREDENTIALS.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY ??= DEFAULT_CREDENTIALS.secretAccessKey;
}

export function awsSimClientConfig(
  credentials: AwsSimCredentials = DEFAULT_CREDENTIALS,
): AwsSimClientConfig {
  return {
    region: DEFAULT_AWS_REGION,
    endpoint: awsSim.endpoint,
    credentials,
  };
}

export function required<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${field}`);
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
