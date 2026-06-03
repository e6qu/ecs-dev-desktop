// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BaseImageEntryDto } from "@edd/api-contracts";
import type { BaseImageEntry } from "@edd/core";

/** Map a catalog domain object to the public API DTO. */
export function toBaseImageDto(entry: BaseImageEntry): BaseImageEntryDto {
  return {
    id: entry.id,
    name: entry.name,
    image: entry.image,
    description: entry.description,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
  };
}
