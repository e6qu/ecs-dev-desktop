// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDetailDto, WorkspaceDto } from "@edd/api-contracts";
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

/** Full admin projection (keeps runtime bindings) for the Inspect view. */
export function toWorkspaceDetail(ws: Workspace): WorkspaceDetailDto {
  return {
    id: ws.id,
    ownerId: ws.ownerId,
    ...(ws.ownerEmail === undefined ? {} : { ownerEmail: ws.ownerEmail }),
    ...(ws.repoUrl === undefined ? {} : { repoUrl: ws.repoUrl }),
    baseImage: ws.baseImage,
    state: ws.state,
    ...(ws.desiredState === undefined ? {} : { desiredState: ws.desiredState }),
    ...(ws.deleteRequestedAt === undefined ? {} : { deleteRequestedAt: ws.deleteRequestedAt }),
    createdAt: ws.createdAt,
    lastActivity: ws.lastActivity,
    ...(ws.volumeId === undefined ? {} : { volumeId: ws.volumeId }),
    ...(ws.taskId === undefined ? {} : { taskId: ws.taskId }),
    ...(ws.latestSnapshotId === undefined ? {} : { latestSnapshotId: ws.latestSnapshotId }),
    ...(ws.latestSnapshotAt === undefined ? {} : { latestSnapshotAt: ws.latestSnapshotAt }),
    ...(ws.sshHost === undefined ? {} : { sshHost: ws.sshHost }),
    ...(ws.functional === undefined ? {} : { functional: ws.functional }),
    ...(ws.functionalDetail === undefined ? {} : { functionalDetail: ws.functionalDetail }),
    ...(ws.functionalAt === undefined ? {} : { functionalAt: ws.functionalAt }),
  };
}
