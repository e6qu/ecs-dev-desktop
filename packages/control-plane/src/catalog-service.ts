// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImageEntryDto } from "@edd/api-contracts";
import {
  applyBaseImagePatch,
  asEditorKind,
  baseImage,
  baseImageId,
  conflictError,
  err,
  findEnabledImage,
  isoTimestamp,
  newBaseImageId,
  notFoundError,
  ok,
  provisionBaseImage,
  type BaseImage,
  type BaseImageEntry,
  type BaseImageId,
  type BaseImagePatch,
  type Clock,
  type DomainError,
  type EditorKind,
  type Result,
} from "@edd/core";
import type { BaseImageEntity } from "@edd/db";

import { toBaseImageDto } from "./base-image-dto";
import { isVersionConflict } from "./version-conflict";

export interface CatalogServiceDeps {
  baseImages: BaseImageEntity;
  clock: Clock;
}

/** The string-shaped persistence record (the DynamoDB boundary). */
interface BaseImageRecord {
  id: string;
  name: string;
  image: string;
  description: string;
  tags?: string[];
  tools?: string[];
  enabled: boolean;
  editor?: string;
  createdAt: string;
  version: number;
}

/** A loaded entry with its persistence-layer version (for optimistic concurrency). */
interface LoadedEntry {
  entry: BaseImageEntry;
  version: number;
}

function toEntry(r: BaseImageRecord): BaseImageEntry {
  return {
    id: baseImageId(r.id),
    name: r.name,
    image: baseImage(r.image),
    description: r.description,
    tags: r.tags ?? [],
    tools: r.tools ?? [],
    enabled: r.enabled,
    editor: asEditorKind(r.editor),
    createdAt: isoTimestamp(r.createdAt),
  };
}

/**
 * Admin-managed catalog of golden base images. Imperative shell over the pure
 * `@edd/core` catalog functions: it does the DynamoDB I/O, the core decides.
 * Updates use optimistic-concurrency CAS (version-conditioned writes) so two
 * concurrent admin edits cannot silently clobber each other.
 */
export class CatalogService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  async list(): Promise<BaseImageEntryDto[]> {
    const entries = await this.all();
    return entries.map((e) => toBaseImageDto(e));
  }

  async get(id: BaseImageId): Promise<BaseImageEntryDto | null> {
    const loaded = await this.find(id);
    return loaded === null ? null : toBaseImageDto(loaded.entry);
  }

  async create(input: {
    name: string;
    image: BaseImage;
    description?: string;
    tags?: readonly string[];
    tools?: readonly string[];
    enabled?: boolean;
    editor?: EditorKind;
  }): Promise<BaseImageEntryDto> {
    const entry = provisionBaseImage({
      id: newBaseImageId(),
      name: input.name,
      image: input.image,
      description: input.description,
      tags: input.tags,
      tools: input.tools,
      enabled: input.enabled,
      editor: input.editor,
      at: isoTimestamp(this.deps.clock.now()),
    });
    await this.persistNew(entry);
    return toBaseImageDto(entry);
  }

  async update(
    id: BaseImageId,
    patch: BaseImagePatch,
  ): Promise<Result<BaseImageEntryDto, DomainError>> {
    const loaded = await this.find(id);
    if (loaded === null) return err(notFoundError("base image", id));
    const next = applyBaseImagePatch(loaded.entry, patch);
    try {
      await this.persistUpdate(next, loaded.version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`update of ${id} lost a concurrent update`));
    }
    return ok(toBaseImageDto(next));
  }

  async rollImageTag(input: {
    repo: string;
    tag: string;
  }): Promise<Result<BaseImageEntryDto, DomainError>> {
    const loaded = (await this.allLoaded()).filter((e) =>
      imageRefMatchesRepo(e.entry.image, input.repo),
    );
    if (loaded.length === 0) {
      return err(conflictError(`no catalog entry points at image repo ${input.repo}`));
    }
    if (loaded.length > 1) {
      return err(conflictError(`multiple catalog entries point at image repo ${input.repo}`));
    }

    const current = loaded[0];
    if (current === undefined) throw new Error("catalog rollout candidate disappeared");
    const nextImage = baseImage(replaceImageTag(current.entry.image, input.tag));
    const next = applyBaseImagePatch(current.entry, { image: nextImage });
    try {
      await this.persistUpdate(next, current.version);
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`rollout of ${input.repo} lost a concurrent update`));
    }
    return ok(toBaseImageDto(next));
  }

  async remove(id: BaseImageId): Promise<Result<void, DomainError>> {
    const loaded = await this.find(id);
    if (loaded === null) return err(notFoundError("base image", id));
    try {
      await this.deps.baseImages
        .delete({ id })
        .where(({ version }, { eq }) => eq(version, loaded.version))
        .go();
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      return err(conflictError(`remove of ${id} lost a concurrent update`));
    }
    return ok(undefined);
  }

  /** Ok only if `image` is an enabled catalog entry — the workspace-create guard. */
  async assertEnabled(image: BaseImage): Promise<Result<void, DomainError>> {
    if (findEnabledImage(await this.all(), image) === undefined) {
      return err(conflictError(`base image is not in the catalog: ${image}`));
    }
    return ok(undefined);
  }

  /** The editor a workspace launched from `image` should serve (the entry's choice, default
   * OpenVSCode). The workspace-create route reads this to thread it into the launch. */
  async editorForImage(image: BaseImage): Promise<EditorKind> {
    return asEditorKind(findEnabledImage(await this.all(), image)?.editor);
  }

  private async all(): Promise<BaseImageEntry[]> {
    return (await this.allLoaded()).map((loaded) => loaded.entry);
  }

  private async allLoaded(): Promise<LoadedEntry[]> {
    const { data } = await this.deps.baseImages.query.byCatalog({}).go({ pages: "all" });
    return (data as readonly BaseImageRecord[]).map((record) => ({
      entry: toEntry(record),
      version: requiredVersion(record),
    }));
  }

  private async find(id: BaseImageId): Promise<LoadedEntry | null> {
    const { data } = await this.deps.baseImages.get({ id }).go();
    if (data === null) return null;
    const record = data as BaseImageRecord;
    return { entry: toEntry(record), version: requiredVersion(record) };
  }

  /** Insert a new entry (conditional on attribute_not_exists — ElectroDB `.create()`). */
  private async persistNew(entry: BaseImageEntry): Promise<void> {
    await this.deps.baseImages
      .create({
        id: entry.id,
        name: entry.name,
        image: entry.image,
        description: entry.description,
        tags: [...entry.tags],
        tools: [...entry.tools],
        enabled: entry.enabled,
        editor: entry.editor,
        createdAt: entry.createdAt,
        version: 0,
      })
      .go();
  }

  /** Update an existing entry with optimistic-concurrency CAS. */
  private async persistUpdate(entry: BaseImageEntry, observedVersion: number): Promise<void> {
    await this.deps.baseImages
      .patch({ id: entry.id })
      .set({
        name: entry.name,
        image: entry.image,
        description: entry.description,
        tags: [...entry.tags],
        tools: [...entry.tools],
        enabled: entry.enabled,
        editor: entry.editor,
        version: observedVersion + 1,
      })
      .where(({ version }, { eq }) => eq(version, observedVersion))
      .go();
  }
}

function requiredVersion(record: BaseImageRecord): number {
  if (!Number.isInteger(record.version)) {
    throw new Error(`base image ${record.id} is missing required catalog version`);
  }
  return record.version;
}

function imageRefMatchesRepo(image: BaseImage, repo: string): boolean {
  const withoutTag = imageRefWithoutTag(image);
  return withoutTag === repo || withoutTag.endsWith(`/${repo}`);
}

function replaceImageTag(image: BaseImage, tag: string): string {
  if (tag.trim() === "") throw new Error("image tag is required");
  return `${imageRefWithoutTag(image)}:${tag}`;
}

function imageRefWithoutTag(image: BaseImage): string {
  const ref = String(image);
  const tagSep = ref.lastIndexOf(":");
  if (tagSep <= ref.lastIndexOf("/")) {
    throw new Error(`catalog image reference has no tag: ${ref}`);
  }
  return ref.slice(0, tagSep);
}
