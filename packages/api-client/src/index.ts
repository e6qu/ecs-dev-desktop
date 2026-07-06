// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  auditFeedResponse,
  baseImageEntry,
  costReport,
  costRollupResponse,
  quotaReport,
  overviewReport,
  createBaseImageRequest,
  createWorkspaceRequest,
  errorResponse,
  configSyncReport,
  healthReport,
  infrastructureReport,
  listBaseImagesResponse,
  listSshKeysResponse,
  listWorkspacesResponse,
  logStreamResult,
  registerSshKeyRequest,
  registerSshKeyResponse,
  sshConnectInfo,
  updateBaseImageRequest,
  workspace,
  workspaceLogs,
  workspaceMonitoring,
  workspaceInspection,
  type AuditFeedResponse,
  type BaseImageEntryDto,
  type CreateBaseImageRequest,
  type CreateWorkspaceRequest,
  type CostReport,
  type CostWindow,
  type QuotaReportDto,
  type OverviewReportDto,
  type HealthReportDto,
  type ConfigSyncReportDto,
  type InfrastructureReportDto,
  type ListBaseImagesResponse,
  type ListWorkspacesResponse,
  type LogStreamDto,
  type LogStreamResultDto,
  type RegisterSshKeyRequest,
  type SshConnectInfo,
  type SshKeyDto,
  type UpdateBaseImageRequest,
  type WorkspaceDto,
  type WorkspaceLogsDto,
  type WorkspaceMonitoringDto,
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
      // Fall back to a status-based message if the body is empty/non-JSON (e.g. a
      // framework 500) so callers get a clean ApiError, never an opaque
      // "Unexpected end of JSON input" from `res.json()`.
      let message = `request failed (HTTP ${res.status.toString()})`;
      try {
        message = errorResponse.parse(await res.json()).error;
      } catch {
        // keep the status-based fallback
      }
      throw new ApiError(res.status, message);
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

  /** The owner-facing slice of one workspace's container (boot/runtime) logs. */
  async getWorkspaceLogs(id: string): Promise<WorkspaceLogsDto> {
    const res = await this.send(`/api/workspaces/${id}/logs`);
    return workspaceLogs.parse(await res.json());
  }

  /** Per-workspace monitoring: sizing, uptime, cost so far, utilization + IOPS. */
  async getWorkspaceMonitoring(id: string): Promise<WorkspaceMonitoringDto> {
    const res = await this.send(`/api/workspaces/${id}/monitoring`);
    return workspaceMonitoring.parse(await res.json());
  }

  async stopWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/stop`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  /** Cancel an in-flight manual stop and resume the session. */
  async cancelStopWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/cancel-stop`, { method: "POST" });
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

  /** Get the host:port of a running workspace's task ENI sshd (wake first via
   * connectWorkspace). SSH-only: the browser editor port is served by the in-app
   * `/w/<id>/` proxy, not this endpoint, so there is no protocol selector. */
  async connectInfo(id: string): Promise<SshConnectInfo> {
    const res = await this.send(`/api/workspaces/${id}/connect-info`);
    return sshConnectInfo.parse(await res.json());
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.send(`/api/workspaces/${id}`, { method: "DELETE" });
  }

  /** Permanently delete a terminated workspace (irreversible; reaps its snapshot). */
  async purgeWorkspace(id: string): Promise<void> {
    await this.send(`/api/workspaces/${id}/purge`, { method: "POST" });
  }

  /** Restore a deleted (terminated) workspace within the undelete-retention window. */
  async undeleteWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/undelete`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  /** Retry a failed launch (error state → relaunch, or recover+start with a snapshot). */
  async retryWorkspace(id: string): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/retry`, { method: "POST" });
    return workspace.parse(await res.json());
  }

  /** Toggle the owner's spectate (read-only mirror) flag. */
  async setWorkspaceShare(id: string, enabled: boolean): Promise<WorkspaceDto> {
    const res = await this.send(`/api/workspaces/${id}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return workspace.parse(await res.json());
  }

  // --- Account SSH keys ---

  /** The caller's registered SSH public keys. */
  async listSshKeys(): Promise<SshKeyDto[]> {
    const res = await this.send("/api/ssh-keys");
    return listSshKeysResponse.parse(await res.json()).keys;
  }

  /** Register an account-level SSH public key (409 if already registered). */
  async registerSshKey(req: RegisterSshKeyRequest): Promise<SshKeyDto> {
    const body = registerSshKeyRequest.parse(req);
    const res = await this.send("/api/ssh-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return registerSshKeyResponse.parse(await res.json()).key;
  }

  /** Delete one of the caller's registered SSH keys. */
  async deleteSshKey(id: string): Promise<void> {
    await this.send(`/api/ssh-keys/${id}`, { method: "DELETE" });
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

  /** Aggregate Infrastructure view: dependency status, ECS cluster state, fleet
   * metrics, and the component topology (with live status). */
  async adminInfrastructure(): Promise<InfrastructureReportDto> {
    const res = await this.send("/api/admin/infrastructure");
    return infrastructureReport.parse(await res.json());
  }

  /** Config-sync self-check: is the deployment wired the way it should be (real
   * providers, ECS/EBS + observability coordinates, DynamoDB + cluster reachable)? */
  async adminConfigSync(): Promise<ConfigSyncReportDto> {
    const res = await this.send("/api/admin/config-sync");
    return configSyncReport.parse(await res.json());
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

  /** The fleet cost report (priced lifecycle ledger), per session + per user +
   * fleet total. `window` scopes it to the last N days (default `all` = lifetime). */
  async adminCosts(window?: CostWindow): Promise<CostReport> {
    const qs = window === undefined ? "" : `?window=${window}`;
    const res = await this.send(`/api/admin/costs${qs}`);
    return costReport.parse(await res.json());
  }

  /** Regenerate the per-workspace cost checkpoints (a scheduled/cron admin call) so the
   * cost report stays O(recent). Same figures — just refreshes the rollup. */
  async adminCostsRollup(): Promise<void> {
    const res = await this.send("/api/admin/costs/rollup", { method: "POST" });
    costRollupResponse.parse(await res.json());
  }

  /** The quota report: per-role workspace limits + current per-user usage. */
  async adminQuotas(): Promise<QuotaReportDto> {
    const res = await this.send("/api/admin/quotas");
    return quotaReport.parse(await res.json());
  }

  /** The overview report: at-a-glance fleet + catalog counts. */
  async adminOverview(): Promise<OverviewReportDto> {
    const res = await this.send("/api/admin/overview");
    return overviewReport.parse(await res.json());
  }

  /** Read one admin log stream; CloudWatch-backed on AWS. An optional
   * `workspaceId` narrows the `container` stream to that workspace's task. */
  async adminLogs(stream: LogStreamDto, workspaceId?: string): Promise<LogStreamResultDto> {
    const qs = workspaceId === undefined ? "" : `&workspaceId=${encodeURIComponent(workspaceId)}`;
    const res = await this.send(`/api/admin/logs?stream=${stream}${qs}`);
    return logStreamResult.parse(await res.json());
  }
}
