// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/**
 * API-first contracts: the single source of truth for the control-plane API.
 * The Next.js route handlers validate against these, and `@edd/api-client`
 * consumes the inferred types — UI and external clients use the same surface.
 */

export const workspaceState = z.enum([
  "provisioning",
  "running",
  "idle",
  "stopped",
  "terminated",
  "error",
]);
export type WorkspaceStateDto = z.infer<typeof workspaceState>;

export const workspace = z.object({
  id: z.string(),
  ownerId: z.string(),
  baseImage: z.string(),
  state: workspaceState,
  createdAt: z.string().datetime(),
});
export type WorkspaceDto = z.infer<typeof workspace>;

export const createWorkspaceRequest = z.object({
  baseImage: z.string().min(1),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequest>;

export const listWorkspacesResponse = z.object({
  workspaces: z.array(workspace),
});
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponse>;
