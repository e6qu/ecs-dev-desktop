// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock, GitProviderId, OwnerId } from "@edd/core";
import type { GitCredentialEntity } from "@edd/db";

import { decryptToken, encryptToken } from "./token-crypto";

/**
 * Stores a user's git token encrypted at rest (AES-256-GCM) and returns it only
 * to authorized server-side callers — the boot-time credential broker (so a
 * session can clone/push private repos) and the GitHub API routes. The token is
 * never stored or transmitted in plaintext at rest, and never reaches the
 * browser or task metadata.
 */
const DEFAULT_PROVIDER: GitProviderId = "github";

export interface GitCredentialServiceDeps {
  credentials: GitCredentialEntity;
  /** 32-byte AES key as hex (from KMS/Secrets Manager in production). */
  encryptionKeyHex: string;
  clock: Clock;
}

export class GitCredentialService {
  constructor(private readonly deps: GitCredentialServiceDeps) {}

  /** Encrypt + persist the owner's git token (upsert). */
  async store(
    ownerId: OwnerId,
    token: string,
    provider: GitProviderId = DEFAULT_PROVIDER,
  ): Promise<void> {
    const ciphertext = encryptToken(token, this.deps.encryptionKeyHex);
    await this.deps.credentials
      .put({ ownerId, provider, ciphertext, updatedAt: this.deps.clock.now() })
      .go();
  }

  /** Decrypt + return the owner's git token, or null if none is stored. */
  async fetch(ownerId: OwnerId, provider: GitProviderId = DEFAULT_PROVIDER): Promise<string | null> {
    const { data } = await this.deps.credentials.get({ ownerId, provider }).go();
    if (data === null) return null;
    return decryptToken(data.ciphertext, this.deps.encryptionKeyHex);
  }

  /** Delete the owner's stored credential (e.g. on sign-out / revocation). */
  async remove(ownerId: OwnerId, provider: GitProviderId = DEFAULT_PROVIDER): Promise<void> {
    await this.deps.credentials.delete({ ownerId, provider }).go();
  }
}
