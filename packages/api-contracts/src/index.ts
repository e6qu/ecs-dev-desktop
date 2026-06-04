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
  createdAt: z.iso.datetime(),
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

// --- Base-image catalog (admin-managed golden images users launch from) ---

export const baseImageEntry = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type BaseImageEntryDto = z.infer<typeof baseImageEntry>;

export const createBaseImageRequest = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type CreateBaseImageRequest = z.infer<typeof createBaseImageRequest>;

/** Partial update; the id and image ref are immutable. At least one field. */
export const updateBaseImageRequest = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((p) => p.name !== undefined || p.description !== undefined || p.enabled !== undefined, {
    message: "at least one field is required",
  });
export type UpdateBaseImageRequest = z.infer<typeof updateBaseImageRequest>;

export const listBaseImagesResponse = z.object({
  baseImages: z.array(baseImageEntry),
});
export type ListBaseImagesResponse = z.infer<typeof listBaseImagesResponse>;

// --- Admin: health board ---

export const healthStatus = z.enum(["ok", "degraded", "down", "unknown"]);
export type HealthStatusDto = z.infer<typeof healthStatus>;

export const componentHealth = z.object({
  component: z.string(),
  status: healthStatus,
  detail: z.string().optional(),
});
export type ComponentHealthDto = z.infer<typeof componentHealth>;

export const healthReport = z.object({
  status: healthStatus,
  components: z.array(componentHealth),
  checkedAt: z.iso.datetime(),
});
export type HealthReportDto = z.infer<typeof healthReport>;
