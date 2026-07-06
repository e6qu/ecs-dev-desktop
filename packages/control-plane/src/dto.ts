// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDetailDto, WorkspaceDto } from "@edd/api-contracts";
import { workspaceActions, type Workspace } from "@edd/core";

/** Map the Workspace domain object to the public API DTO (drops runtime bindings).
 * `repoUrl` is part of the public contract (the in-workspace git-credential broker
 * reads it back via `get()` to scope the provider token to the repo's owner), so it
 * must round-trip here — not only on the admin projection below. */
export function toWorkspaceDto(ws: Workspace): WorkspaceDto {
  return {
    id: ws.id,
    ownerId: ws.ownerId,
    ...(ws.ownerEmail === undefined ? {} : { ownerEmail: ws.ownerEmail }),
    ...(ws.ownerRole === undefined ? {} : { ownerRole: ws.ownerRole }),
    ...(ws.repoUrl === undefined ? {} : { repoUrl: ws.repoUrl }),
    baseImage: ws.baseImage,
    ...(ws.editor === undefined ? {} : { editor: ws.editor }),
    state: ws.state,
    createdAt: ws.createdAt,
    lastActivity: ws.lastActivity,
    ...(ws.stopRequestedAt === undefined ? {} : { stopRequestedAt: ws.stopRequestedAt }),
    availableActions: [...workspaceActions(ws.state)],
    ...(ws.functional === undefined ? {} : { functional: ws.functional }),
    ...(ws.functionalDetail === undefined ? {} : { functionalDetail: ws.functionalDetail }),
    ...(ws.diskUsedBytes === undefined ? {} : { diskUsedBytes: ws.diskUsedBytes }),
    ...(ws.diskTotalBytes === undefined ? {} : { diskTotalBytes: ws.diskTotalBytes }),
    ...(ws.terminatedAt === undefined ? {} : { terminatedAt: ws.terminatedAt }),
    ...(ws.shareEnabled === undefined ? {} : { shareEnabled: ws.shareEnabled }),
  };
}

/** Full admin projection (keeps runtime bindings) for the Inspect view. */
export function toWorkspaceDetail(ws: Workspace): WorkspaceDetailDto {
  return {
    id: ws.id,
    ownerId: ws.ownerId,
    ...(ws.ownerEmail === undefined ? {} : { ownerEmail: ws.ownerEmail }),
    ...(ws.ownerRole === undefined ? {} : { ownerRole: ws.ownerRole }),
    ...(ws.repoUrl === undefined ? {} : { repoUrl: ws.repoUrl }),
    baseImage: ws.baseImage,
    ...(ws.editor === undefined ? {} : { editor: ws.editor }),
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
    ...(ws.diskUsedBytes === undefined ? {} : { diskUsedBytes: ws.diskUsedBytes }),
    ...(ws.diskTotalBytes === undefined ? {} : { diskTotalBytes: ws.diskTotalBytes }),
    ...(ws.terminatedAt === undefined ? {} : { terminatedAt: ws.terminatedAt }),
    ...(ws.shareEnabled === undefined ? {} : { shareEnabled: ws.shareEnabled }),
    availableActions: [...workspaceActions(ws.state)],
  };
}
