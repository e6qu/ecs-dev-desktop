// SPDX-License-Identifier: AGPL-3.0-or-later
import { GitCredentialService, GitSshKeyService } from "@edd/control-plane";
import { systemClock } from "@edd/core";
import { createDynamoClient, makeGitCredentialEntity, makeGitSshKeyEntity, TABLE } from "@edd/db";
// ssh2 is CommonJS: a default import is the one shape that works under both the bundled
// (Next.js) and native-ESM (tsx) consumers.
import ssh2 from "ssh2";

/**
 * Server-side accessor for the per-user git credential store (encrypted at
 * rest). The token is captured at GitHub sign-in and read back only by the
 * boot-time credential broker (so a session can clone/push private repos) and
 * the GitHub API routes — never exposed to the browser.
 *
 * The feature is gated on `EDD_TOKEN_ENC_KEY` (32-byte AES key, hex). When it is
 * absent the feature is simply off (public repos still clone); when present the
 * key is required and a missing/invalid one fails loudly. The same key protects the
 * user-generated git SSH keys ({@link getGitSshKeys}), whose private halves are
 * decrypted only for the workspace broker.
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

let sshKeys: GitSshKeyService | undefined;

export function getGitSshKeys(): GitSshKeyService {
  const key = encryptionKey();
  if (key === undefined) throw new Error("EDD_TOKEN_ENC_KEY is required for git SSH keys");
  sshKeys ??= new GitSshKeyService({
    keys: makeGitSshKeyEntity(createDynamoClient(), tableName()),
    encryptionKeyHex: key,
    generateKeyPair: (comment) => {
      const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment });
      return { publicKey: pair.public, privateKey: pair.private };
    },
    clock: systemClock,
  });
  return sshKeys;
}
