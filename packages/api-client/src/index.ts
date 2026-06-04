// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  auditFeedResponse,
  baseImageEntry,
  createBaseImageRequest,
  createWorkspaceRequest,
  errorResponse,
  healthReport,
  listBaseImagesResponse,
  listWorkspacesResponse,
  logStreamResult,
  updateBaseImageRequest,
  workspace,
  workspaceInspection,
  type AuditFeedResponse,
  type BaseImageEntryDto,
  type CreateBaseImageRequest,
  type CreateWorkspaceRequest,
  type HealthReportDto,
  type ListBaseImagesResponse,
  type ListWorkspacesResponse,
  type LogStreamDto,
  type LogStreamResultDto,
  type UpdateBaseImageRequest,
  type WorkspaceDto,
  type WorkspaceInspectionDto,
} from "@edd/api-contracts";

/**
 * Typed control-plane client generated from the contracts. The UI and external
 * callers use this exact client — API-first means there is no privileged
 * back-channel. `fetch` is injectable so it is trivially testable.
 */
export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * A failed API call. Carries the server's typed error message (from the
 * `{ error }` body) so the UI can show the real reason — e.g. "workspace quota
 * reached" — rather than a bare status, plus the `status` for callers that branch
 * on it.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    // Bind to globalThis: the browser's `window.fetch` throws "Illegal invocation"
    // if called detached from `window` (Node's fetch tolerates it, hiding this).
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      // Every API error response carries `{ error }` (the helpers + domainErrorResponse).
      // Parse strictly — a response that violates the contract is a bug, so let the
      // parse throw rather than smooth it into a synthesized message.
      const body = errorResponse.parse(await res.json());
      throw new ApiError(res.status, body.error);
    }
    return res;
  }

  async listWorkspaces(): Promise<ListWorkspacesResponse> {
    const res = await this.send("/api/workspaces");
    return listWorkspacesResponse.parse(await res.json());
  }

  async createWorkspace(req: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const body = createWorkspaceRequest.parse(req);
    const res = await this.send("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return workspace.parse(await res.json());
  }

  async getWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}`);
    return workspace.parse(await res.json());
  }

  async stopWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/stop`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  async startWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/start`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  /** Wake-on-connect: ensure the workspace is reachable (idempotent), waking it
   * from its snapshot if scaled to zero. Used by the connection path. */
  async connectWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/connect`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  async snapshotWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/snapshot`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  /** Idle-agent heartbeat — report activity to keep the workspace from scaling to zero. */
  async heartbeatWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/heartbeat`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.send(`/api/workspaces/${id}`, { method: "DELETE" });
  }

  // --- Base-image catalog ---

  async listBaseImages(): Promise<ListBaseImagesResponse> {
    const res = await this.send("/api/base-images");
    return listBaseImagesResponse.parse(await res.json());
  }

  async getBaseImage(id: string): Promise<BaseImageEntryDto> {
    const res = await this.send(`/api/base-images/${id}`);
    return baseImageEntry.parse(await res.json());
  }

  async createBaseImage(req: CreateBaseImageRequest): Promise<BaseImageEntryDto> {
    const body = createBaseImageRequest.parse(req);
    const res = await this.send("/api/base-images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return baseImageEntry.parse(await res.json());
  }

  async updateBaseImage(id: string, req: UpdateBaseImageRequest): Promise<BaseImageEntryDto> {
    const body = updateBaseImageRequest.parse(req);
    const res = await this.send(`/api/base-images/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return baseImageEntry.parse(await res.json());
  }

  async deleteBaseImage(id: string): Promise<void> {
    await this.send(`/api/base-images/${id}`, { method: "DELETE" });
  }

  // --- Admin ---

  async adminHealth(): Promise<HealthReportDto> {
    const res = await this.send("/api/admin/health");
    return healthReport.parse(await res.json());
  }

  async adminWorkspaces(): Promise<ListWorkspacesResponse> {
    const res = await this.send("/api/admin/workspaces");
    return listWorkspacesResponse.parse(await res.json());
  }

  async adminInspectWorkspace(id: string): Promise<WorkspaceInspectionDto> {
    const res = await this.send(`/api/admin/workspaces/${id}`);
    return workspaceInspection.parse(await res.json());
  }

  /** Derived fleet audit feed (newest first); CloudTrail-backed on AWS. */
  async adminAudit(): Promise<AuditFeedResponse> {
    const res = await this.send("/api/admin/audit");
    return auditFeedResponse.parse(await res.json());
  }

  /** Read one admin log stream; CloudWatch-backed on AWS. */
  async adminLogs(stream: LogStreamDto): Promise<LogStreamResultDto> {
    const res = await this.send(`/api/admin/logs?stream=${stream}`);
    return logStreamResult.parse(await res.json());
  }
}
