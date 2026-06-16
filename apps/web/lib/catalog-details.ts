// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImageEntryDto } from "@edd/api-contracts";

export interface CatalogDetails {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly tools: readonly string[];
}

export function catalogDetailsByImage(
  entries: readonly BaseImageEntryDto[],
): ReadonlyMap<string, CatalogDetails> {
  return new Map(
    entries.map((entry) => [
      entry.image,
      {
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
        tools: entry.tools,
      },
    ]),
  );
}

export function lookupCatalogDetails(
  entries: ReadonlyMap<string, CatalogDetails>,
  image: string,
): CatalogDetails {
  return entries.get(image) ?? { name: image, description: "", tags: [], tools: [] };
}
