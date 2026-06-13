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
/** A user's email — the provider-agnostic identity used to match a proxy-
 * authenticated caller to a workspace owner (IdP `sub`/`oid` differ across the
 * Auth.js portal IdP and the Pomerium proxy IdP; the email claim is shared). */
export type Email = Brand<string, "Email">;

/** Smart constructors (validate/brand an existing string). */
export const workspaceId = (value: string): WorkspaceId => brand<"WorkspaceId">(value);
export const ownerId = (value: string): OwnerId => brand<"OwnerId">(value);
export const baseImage = (value: string): BaseImage => brand<"BaseImage">(value);
export const baseImageId = (value: string): BaseImageId => brand<"BaseImageId">(value);
export const volumeId = (value: string): VolumeId => brand<"VolumeId">(value);
export const snapshotId = (value: string): SnapshotId => brand<"SnapshotId">(value);
export const taskId = (value: string): TaskId => brand<"TaskId">(value);
export const isoTimestamp = (value: string): IsoTimestamp => brand<"IsoTimestamp">(value);

/** Smart constructor for {@link Email}: validates a basic `local@domain.tld`
 * shape and normalises to lowercase so owner/caller comparison is
 * case-insensitive (IdPs treat email case-insensitively). Throws (loud) on a
 * malformed value rather than silently branding garbage. */
export const email = (value: string): Email => {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
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
