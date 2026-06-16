// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImageEntryDto } from "@edd/api-contracts";
import {
  applyBaseImagePatch,
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
  type Result,
} from "@edd/core";
import type { BaseImageEntity } from "@edd/db";

import { toBaseImageDto } from "./base-image-dto";

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
  createdAt: string;
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
    createdAt: isoTimestamp(r.createdAt),
  };
}

/**
 * Admin-managed catalog of golden base images. Imperative shell over the pure
 * `@edd/core` catalog functions: it does the DynamoDB I/O, the core decides.
 */
export class CatalogService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  async list(): Promise<BaseImageEntryDto[]> {
    const entries = await this.all();
    return entries.map((e) => toBaseImageDto(e));
  }

  async get(id: BaseImageId): Promise<BaseImageEntryDto | null> {
    const entry = await this.find(id);
    return entry === null ? null : toBaseImageDto(entry);
  }

  async create(input: {
    name: string;
    image: BaseImage;
    description?: string;
    tags?: readonly string[];
    tools?: readonly string[];
    enabled?: boolean;
  }): Promise<BaseImageEntryDto> {
    const entry = provisionBaseImage({
      id: newBaseImageId(),
      name: input.name,
      image: input.image,
      description: input.description,
      tags: input.tags,
      tools: input.tools,
      enabled: input.enabled,
      at: isoTimestamp(this.deps.clock.now()),
    });
    await this.persist(entry);
    return toBaseImageDto(entry);
  }

  async update(
    id: BaseImageId,
    patch: BaseImagePatch,
  ): Promise<Result<BaseImageEntryDto, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    const next = applyBaseImagePatch(found.value, patch);
    await this.persist(next);
    return ok(toBaseImageDto(next));
  }

  async remove(id: BaseImageId): Promise<Result<void, DomainError>> {
    const found = await this.require(id);
    if (!found.ok) return found;
    await this.deps.baseImages.delete({ id }).go();
    return ok(undefined);
  }

  /** Ok only if `image` is an enabled catalog entry — the workspace-create guard. */
  async assertEnabled(image: BaseImage): Promise<Result<void, DomainError>> {
    if (findEnabledImage(await this.all(), image) === undefined) {
      return err(conflictError(`base image is not in the catalog: ${image}`));
    }
    return ok(undefined);
  }

  private async all(): Promise<BaseImageEntry[]> {
    const { data } = await this.deps.baseImages.query.byCatalog({}).go({ pages: "all" });
    return data.map((r: BaseImageRecord) => toEntry(r));
  }

  private async find(id: BaseImageId): Promise<BaseImageEntry | null> {
    const { data } = await this.deps.baseImages.get({ id }).go();
    return data === null ? null : toEntry(data);
  }

  private async require(id: BaseImageId): Promise<Result<BaseImageEntry, DomainError>> {
    const entry = await this.find(id);
    return entry === null ? err(notFoundError("base image", id)) : ok(entry);
  }

  private async persist(entry: BaseImageEntry): Promise<void> {
    await this.deps.baseImages
      .put({
        id: entry.id,
        name: entry.name,
        image: entry.image,
        description: entry.description,
        tags: [...entry.tags],
        tools: [...entry.tools],
        enabled: entry.enabled,
        createdAt: entry.createdAt,
      })
      .go();
  }
}
