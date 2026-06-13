// SPDX-License-Identifier: AGPL-3.0-or-later
import { GitCredentialService } from "@edd/control-plane";
import { systemClock } from "@edd/core";
import { createDynamoClient, makeGitCredentialEntity, TABLE } from "@edd/db";

/**
 * Server-side accessor for the per-user git credential store (encrypted at
 * rest). The token is captured at GitHub sign-in and read back only by the
 * boot-time credential broker (so a session can clone/push private repos) and
 * the GitHub API routes — never exposed to the browser.
 *
 * The feature is gated on `EDD_TOKEN_ENC_KEY` (32-byte AES key, hex). When it is
 * absent the feature is simply off (public repos still clone); when present the
 * key is required and a missing/invalid one fails loudly.
 */
function tableName(): string {
  return process.env.DYNAMODB_TABLE ?? TABLE;
}

function encryptionKey(): string | undefined {
  const key = process.env.EDD_TOKEN_ENC_KEY;
  return key !== undefined && key.length > 0 ? key : undefined;
}

/** True when git-credential storage is configured (EDD_TOKEN_ENC_KEY set). */
export function gitCredentialsEnabled(): boolean {
  return encryptionKey() !== undefined;
}

let instance: GitCredentialService | undefined;

export function getGitCredentials(): GitCredentialService {
  const key = encryptionKey();
  if (key === undefined) throw new Error("EDD_TOKEN_ENC_KEY is required for git credentials");
  instance ??= new GitCredentialService({
    credentials: makeGitCredentialEntity(createDynamoClient(), tableName()),
    encryptionKeyHex: key,
    clock: systemClock,
  });
  return instance;
}
