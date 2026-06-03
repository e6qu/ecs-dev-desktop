// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createWorkspaceRequest,
  listWorkspacesResponse,
  workspace,
  type CreateWorkspaceRequest,
  type ListWorkspacesResponse,
  type WorkspaceDto,
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

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok)
      throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status.toString()}`);
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

  async deleteWorkspace(id: string): Promise<void> {
    await this.send(`/api/workspaces/${id}`, { method: "DELETE" });
  }
}
