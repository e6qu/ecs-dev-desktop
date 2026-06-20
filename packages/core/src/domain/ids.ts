// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";

import { brand, type Brand } from "./brand";
import { ID_PREFIX } from "./constants";

/** Branded identifiers and domain value types — never bare `string`. */
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type OwnerId = Brand<string, "OwnerId">;
export type BaseImage = Brand<string, "BaseImage">;
/** Catalog-entry id — distinct from {@link BaseImage}, the container image ref. */
export type BaseImageId = Brand<string, "BaseImageId">;
export type VolumeId = Brand<string, "VolumeId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type TaskId = Brand<string, "TaskId">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
/** A user's email — the human-facing identity shown for a workspace's owner.
 * (Authorization keys off the stable Auth.js session `uid`, not the email.) */
export type Email = Brand<string, "Email">;
/** A registered SSH key's record id. */
export type SshKeyId = Brand<string, "SshKeyId">;
/** An OpenSSH public-key line: `<type> <base64-blob> [comment]`. */
export type SshPublicKey = Brand<string, "SshPublicKey">;
/** An OpenSSH SHA256 key fingerprint, e.g. `SHA256:<base64-no-pad>` — the stable
 * identity a key is deduped and looked up by (see `fingerprintPublicKey`). */
export type SshKeyFingerprint = Brand<string, "SshKeyFingerprint">;
/** The git hosting provider a stored credential belongs to. A closed union (not a
 * bare string) so a typo is a compile error and the credential ledger's
 * `(ownerId, provider)` key can never be mis-scoped. Only providers we actually
 * support appear here — adding one is a one-line change (and a real integration). */
export type GitProviderId = "github";

/** Smart constructors (validate/brand an existing string). */
export const workspaceId = (value: string): WorkspaceId => brand<"WorkspaceId">(value);
export const ownerId = (value: string): OwnerId => brand<"OwnerId">(value);
export const baseImage = (value: string): BaseImage => brand<"BaseImage">(value);
export const baseImageId = (value: string): BaseImageId => brand<"BaseImageId">(value);
export const volumeId = (value: string): VolumeId => brand<"VolumeId">(value);
export const snapshotId = (value: string): SnapshotId => brand<"SnapshotId">(value);
export const taskId = (value: string): TaskId => brand<"TaskId">(value);
export const isoTimestamp = (value: string): IsoTimestamp => brand<"IsoTimestamp">(value);
export const sshKeyId = (value: string): SshKeyId => brand<"SshKeyId">(value);
export const sshPublicKey = (value: string): SshPublicKey => brand<"SshPublicKey">(value);
export const sshKeyFingerprint = (value: string): SshKeyFingerprint =>
  brand<"SshKeyFingerprint">(value);

/** Whether a string contains any C0 control character or DEL (indices, not spread, to
 * avoid iterating Unicode code points where char codes are what we mean to check). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Smart constructor for {@link Email}: validates a basic `local@domain.tld`
 * shape and normalises to lowercase so owner/caller comparison is
 * case-insensitive (IdPs treat email case-insensitively). Throws (loud) on a
 * malformed value rather than silently branding garbage. */
export const email = (value: string): Email => {
  const normalized = value.trim().toLowerCase();
  // The `[^\s@]` classes below exclude whitespace but NOT C0 control chars / DEL
  // (NUL is not `\s`), which would otherwise be branded as a valid Email and flow into
  // ownership/display. Reject any control character explicitly first.
  if (hasControlChar(normalized) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`invalid email: ${value}`);
  }
  return brand<"Email">(normalized);
};

/** Fresh-id generators (prefix + UUID). */
export const newWorkspaceId = (): WorkspaceId =>
  workspaceId(`${ID_PREFIX.workspace}${randomUUID()}`);
export const newBaseImageId = (): BaseImageId =>
  baseImageId(`${ID_PREFIX.baseImage}${randomUUID()}`);
export const newVolumeId = (): VolumeId => volumeId(`${ID_PREFIX.volume}${randomUUID()}`);
export const newSnapshotId = (): SnapshotId => snapshotId(`${ID_PREFIX.snapshot}${randomUUID()}`);
export const newTaskId = (): TaskId => taskId(`${ID_PREFIX.task}${randomUUID()}`);
export const newSshKeyId = (): SshKeyId => sshKeyId(`${ID_PREFIX.sshKey}${randomUUID()}`);
