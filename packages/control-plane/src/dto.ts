// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto, WorkspaceStateDto } from "@edd/api-contracts";

/** The subset of a persisted workspace record needed to build the public DTO. */
export interface WorkspaceRecordLike {
  id: string;
  ownerId: string;
  baseImage: string;
  state: WorkspaceStateDto;
  createdAt: string;
}

/** Map an internal workspace record to the public API DTO (drops runtime bindings). */
export function toWorkspaceDto(record: WorkspaceRecordLike): WorkspaceDto {
  return {
    id: record.id,
    ownerId: record.ownerId,
    baseImage: record.baseImage,
    state: record.state,
    createdAt: record.createdAt,
  };
}
