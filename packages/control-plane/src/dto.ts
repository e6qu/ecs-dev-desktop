// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import type { Workspace } from "@edd/core";

/** Map the Workspace domain object to the public API DTO (drops runtime bindings). */
export function toWorkspaceDto(ws: Workspace): WorkspaceDto {
  return {
    id: ws.id,
    ownerId: ws.ownerId,
    baseImage: ws.baseImage,
    state: ws.state,
    createdAt: ws.createdAt,
  };
}
