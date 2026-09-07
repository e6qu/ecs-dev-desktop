// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fingerprintPublicKey,
  newSshKeyId,
  sshKeyType,
  type Clock,
  type OwnerId,
  type SshKeyId,
} from "@edd/core";
import type { GitSshKeyDto } from "@edd/api-contracts";
import { GIT_SSH_KEY_SCHEMA_VERSION, type GitSshKeyEntity } from "@edd/db";

import { newestFirst } from "./newest-first";
import { decryptToken, encryptToken } from "./token-crypto";

/**
 * Platform-generated SSH keypairs a user adds to their git host so their workspaces can
 * clone and push over SSH. The user never handles the private half: it is generated here,
 * stored only as AES-256-GCM ciphertext (the same key that protects git tokens), and
 * decrypted for exactly one caller — the boot-time broker that delivers it into the
 * owner's workspaces over the agent's authenticated channel. The public half is what the
 * owner copies into GitHub.
 *
 * Keys are ed25519 (the modern default GitHub recommends; small, fast, no parameter
 * choices). Generation is a port: the web app supplies ssh2's key utilities, so both
 * halves are in OpenSSH's own formats (the private key is exactly what `ssh` reads from
 * `IdentityFile`) while this package — and the reconciler that bundles it — stays free of
 * that native-backed dependency.
 */

/** An OpenSSH-format keypair: the public line (`ssh-ed25519 AAAA… comment`) and the
 * `-----BEGIN OPENSSH PRIVATE KEY-----` private block. */
export interface GeneratedKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface GitSshKeyServiceDeps {
  keys: GitSshKeyEntity;
  /** 32-byte AES key as hex (from KMS/Secrets Manager in production). */
  encryptionKeyHex: string;
  /** Generate a fresh ed25519 keypair carrying `comment` in the public line. */
  generateKeyPair: (comment: string) => GeneratedKeyPair;
  clock: Clock;
}

/** A key with its private half — for the workspace broker only, never a browser. */
export interface GitSshKeyMaterial extends GitSshKeyDto {
  readonly privateKey: string;
}

/** The comment embedded in a generated public key: who and what it is for. */
function keyComment(ownerId: OwnerId, label: string): string {
  return `edd:${ownerId}:${label}`.replace(/\s+/g, "-");
}

interface GitSshKeyRecord {
  id: string;
  ownerId: string;
  schemaVersion: number;
  label: string;
  keyType: string;
  fingerprint: string;
  publicKey: string;
  privateKeyCiphertext: string;
  createdAt: string;
}

function toDto(record: GitSshKeyRecord): GitSshKeyDto {
  return {
    id: record.id,
    label: record.label,
    keyType: record.keyType,
    fingerprint: record.fingerprint,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
  };
}

/** Persisted rows carry a schema version; only the current one is readable (§6.5a). */
function assertCurrentSchema(record: GitSshKeyRecord): void {
  if (record.schemaVersion !== GIT_SSH_KEY_SCHEMA_VERSION) {
    throw new Error(
      `git SSH key ${record.id} has schema version ${String(record.schemaVersion)}; this build reads only ${String(GIT_SSH_KEY_SCHEMA_VERSION)}`,
    );
  }
}

export class GitSshKeyService {
  constructor(private readonly deps: GitSshKeyServiceDeps) {}

  /** Generate a new ed25519 keypair for `ownerId`, persist it (private half encrypted),
   * and return the public record. */
  async generate(ownerId: OwnerId, label: string): Promise<GitSshKeyDto> {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) throw new Error("a git SSH key needs a label");
    const pair = this.deps.generateKeyPair(keyComment(ownerId, trimmedLabel));
    const publicKey = pair.publicKey.trim();
    const record: GitSshKeyRecord = {
      id: newSshKeyId(),
      ownerId,
      schemaVersion: GIT_SSH_KEY_SCHEMA_VERSION,
      label: trimmedLabel,
      keyType: sshKeyType(publicKey),
      fingerprint: fingerprintPublicKey(publicKey),
      publicKey,
      privateKeyCiphertext: encryptToken(pair.privateKey, this.deps.encryptionKeyHex),
      createdAt: this.deps.clock.now(),
    };
    await this.deps.keys.put(record).go();
    return toDto(record);
  }

  /** The owner's keys (public halves), newest first. */
  async list(ownerId: OwnerId): Promise<GitSshKeyDto[]> {
    const records = await this.records(ownerId);
    return records.map(toDto);
  }

  /** The owner's keys WITH private halves — the workspace broker's read. */
  async materials(ownerId: OwnerId): Promise<GitSshKeyMaterial[]> {
    const records = await this.records(ownerId);
    return records.map((record) => ({
      ...toDto(record),
      privateKey: decryptToken(record.privateKeyCiphertext, this.deps.encryptionKeyHex),
    }));
  }

  /** Delete one of the owner's keys. Ownership-scoped (PK=ownerId), so a caller can never
   * delete another user's key. False when the owner has no such key (route → 404). */
  async remove(ownerId: OwnerId, id: SshKeyId): Promise<boolean> {
    const { data } = await this.deps.keys.get({ ownerId, id }).go();
    if (data === null) return false;
    await this.deps.keys.delete({ ownerId, id }).go();
    return true;
  }

  private async records(ownerId: OwnerId): Promise<GitSshKeyRecord[]> {
    // `pages: "all"`: a bare `.go()` returns only the first Query page.
    const { data } = await this.deps.keys.query.primary({ ownerId }).go({ pages: "all" });
    for (const record of data) assertCurrentSchema(record);
    return newestFirst(data);
  }
}
