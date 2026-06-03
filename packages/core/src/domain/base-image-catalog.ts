// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImage, BaseImageId, IsoTimestamp } from "./ids";

/**
 * A curated golden base image users can launch a workspace from. The admin
 * catalog is the allow-list: workspace creation must reference an **enabled**
 * entry. This and the pure functions below are functional core — data in, a new
 * value out, no I/O; the shell (`CatalogService`) performs persistence.
 */
export interface BaseImageEntry {
  readonly id: BaseImageId;
  /** Human-facing name shown in the picker, e.g. "Node 20 (Debian)". */
  readonly name: string;
  /** The container image reference in ECR/registry. */
  readonly image: BaseImage;
  readonly description: string;
  /** Disabled entries stay in the catalog (history) but can't launch new work. */
  readonly enabled: boolean;
  readonly createdAt: IsoTimestamp;
}

export interface ProvisionBaseImageParams {
  id: BaseImageId;
  name: string;
  image: BaseImage;
  description?: string;
  enabled?: boolean;
  at: IsoTimestamp;
}

/** A mutable patch over an existing entry (id and image ref are immutable). */
export interface BaseImagePatch {
  name?: string;
  description?: string;
  enabled?: boolean;
}

/** Construct a new catalog entry. Fails loudly on an empty name or image ref. */
export function provisionBaseImage(params: ProvisionBaseImageParams): BaseImageEntry {
  if (params.name.trim() === "") throw new Error("base image name is required");
  if (params.image.trim() === "") throw new Error("base image reference is required");
  return {
    id: params.id,
    name: params.name,
    image: params.image,
    description: params.description ?? "",
    enabled: params.enabled ?? true,
    createdAt: params.at,
  };
}

/** Apply a patch, returning a new entry. Empty patch fields leave values intact. */
export function applyBaseImagePatch(entry: BaseImageEntry, patch: BaseImagePatch): BaseImageEntry {
  if (patch.name?.trim() === "") {
    throw new Error("base image name cannot be blank");
  }
  return {
    ...entry,
    name: patch.name ?? entry.name,
    description: patch.description ?? entry.description,
    enabled: patch.enabled ?? entry.enabled,
  };
}

/** The enabled entry for `image`, or undefined if none is enabled in the catalog. */
export function findEnabledImage(
  catalog: readonly BaseImageEntry[],
  image: BaseImage,
): BaseImageEntry | undefined {
  return catalog.find((entry) => entry.enabled && entry.image === image);
}
