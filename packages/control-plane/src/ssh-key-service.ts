// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fingerprintPublicKey,
  newSshKeyId,
  sshKeyType,
  type Clock,
  type SshKeyFingerprint,
} from "@edd/core";
import type { SshKeyDto } from "@edd/api-contracts";
import type { SshKeyEntity } from "@edd/db";

/**
 * Account-level SSH public keys a user registers for SSH access to their
 * workspaces. The gateway authenticates a connecting human by matching the
 * presented public key's fingerprint to a registered key (`ownerForKey`); the
 * specific workspace is then authorized by ownership at connect time.
 *
 * Only the *public* key is ever stored or returned — the private key never
 * reaches the server. A public key is globally unique (it identifies exactly one
 * user), enforced here via the fingerprint index so the gateway lookup is
 * unambiguous.
 */
export interface SshKeyServiceDeps {
  keys: SshKeyEntity;
  clock: Clock;
}

/** Registering a public key already on file (this user's, or — security-relevant
 * — another user's). The route maps this to 409. */
export class SshKeyConflictError extends Error {
  constructor(
    reason: string,
    /** Whether the existing key belongs to the same caller (vs another account). */
    readonly ownedByCaller: boolean,
  ) {
    super(reason);
    this.name = "SshKeyConflictError";
  }
}

interface SshKeyRecord {
  id: string;
  ownerId: string;
  label: string;
  keyType: string;
  fingerprint: string;
  publicKey: string;
  createdAt: string;
}

function toDto(r: SshKeyRecord): SshKeyDto {
  return {
    id: r.id,
    label: r.label,
    keyType: r.keyType,
    fingerprint: r.fingerprint,
    publicKey: r.publicKey,
    createdAt: r.createdAt,
  };
}

/** Default display label when the user gives none: the key comment, else the
 * type plus a short fingerprint tail (e.g. "ssh-ed25519 …Dtddjjoo"). */
function defaultLabel(publicKey: string, keyType: string, fingerprint: SshKeyFingerprint): string {
  const comment = publicKey.trim().split(/\s+/).slice(2).join(" ");
  if (comment.length > 0) return comment;
  return `${keyType} …${fingerprint.slice(-8)}`;
}

export class SshKeyService {
  constructor(private readonly deps: SshKeyServiceDeps) {}

  /** Resolve a presented public key to its registered record, or null. */
  private async findByFingerprint(fingerprint: SshKeyFingerprint): Promise<SshKeyRecord | null> {
    const { data } = await this.deps.keys.query.byFingerprint({ fingerprint }).go();
    return data[0] ?? null;
  }

  /**
   * Register a public key for `ownerId`. Throws {@link SshKeyConflictError} if the
   * key is already on file (idempotency + global uniqueness). The key is validated
   * for shape at the contract boundary; this throws loudly if it can't be
   * fingerprinted at all.
   */
  async register(ownerId: string, publicKey: string, label?: string): Promise<SshKeyDto> {
    const normalized = publicKey.trim();
    const fingerprint = fingerprintPublicKey(normalized);
    const existing = await this.findByFingerprint(fingerprint);
    if (existing !== null) {
      const ownedByCaller = existing.ownerId === ownerId;
      throw new SshKeyConflictError(
        ownedByCaller
          ? "this SSH key is already registered to your account"
          : "this SSH key is already registered to another account",
        ownedByCaller,
      );
    }
    const keyType = sshKeyType(normalized);
    const trimmedLabel = label?.trim();
    const record: SshKeyRecord = {
      id: newSshKeyId(),
      ownerId,
      label:
        trimmedLabel !== undefined && trimmedLabel.length > 0
          ? trimmedLabel
          : defaultLabel(normalized, keyType, fingerprint),
      keyType,
      fingerprint,
      publicKey: normalized,
      createdAt: this.deps.clock.now(),
    };
    await this.deps.keys.put(record).go();
    return toDto(record);
  }

  /** The caller's registered keys, newest first. */
  async list(ownerId: string): Promise<SshKeyDto[]> {
    const { data } = await this.deps.keys.query.primary({ ownerId }).go();
    return data
      .map(toDto)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /**
   * Delete one of the caller's keys. Ownership-scoped (PK=ownerId) so a caller
   * can never delete another user's key. Returns false if the caller has no such
   * key (route → 404).
   */
  async remove(ownerId: string, id: string): Promise<boolean> {
    const { data } = await this.deps.keys.get({ ownerId, id }).go();
    if (data === null) return false;
    await this.deps.keys.delete({ ownerId, id }).go();
    return true;
  }

  /**
   * Gateway lookup: which owner (and key id) does a presented public key belong
   * to? Null when the key isn't registered (connection refused). This is the
   * authentication step — authorization (does this owner own the target
   * workspace?) is a separate check at connect time.
   */
  async ownerForKey(publicKey: string): Promise<{ ownerId: string; keyId: string } | null> {
    const match = await this.findByFingerprint(fingerprintPublicKey(publicKey.trim()));
    return match === null ? null : { ownerId: match.ownerId, keyId: match.id };
  }
}
