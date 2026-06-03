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

/** Smart constructors (validate/brand an existing string). */
export const workspaceId = (value: string): WorkspaceId => brand<"WorkspaceId">(value);
export const ownerId = (value: string): OwnerId => brand<"OwnerId">(value);
export const baseImage = (value: string): BaseImage => brand<"BaseImage">(value);
export const baseImageId = (value: string): BaseImageId => brand<"BaseImageId">(value);
export const volumeId = (value: string): VolumeId => brand<"VolumeId">(value);
export const snapshotId = (value: string): SnapshotId => brand<"SnapshotId">(value);
export const taskId = (value: string): TaskId => brand<"TaskId">(value);
export const isoTimestamp = (value: string): IsoTimestamp => brand<"IsoTimestamp">(value);

/** Fresh-id generators (prefix + UUID). */
export const newWorkspaceId = (): WorkspaceId =>
  workspaceId(`${ID_PREFIX.workspace}${randomUUID()}`);
export const newBaseImageId = (): BaseImageId =>
  baseImageId(`${ID_PREFIX.baseImage}${randomUUID()}`);
export const newVolumeId = (): VolumeId => volumeId(`${ID_PREFIX.volume}${randomUUID()}`);
export const newSnapshotId = (): SnapshotId => snapshotId(`${ID_PREFIX.snapshot}${randomUUID()}`);
export const newTaskId = (): TaskId => taskId(`${ID_PREFIX.task}${randomUUID()}`);
