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

  async listWorkspaces(): Promise<ListWorkspacesResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/workspaces`);
    if (!res.ok) throw new Error(`listWorkspaces failed: ${res.status}`);
    return listWorkspacesResponse.parse(await res.json());
  }

  async createWorkspace(req: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const body = createWorkspaceRequest.parse(req);
    const res = await this.fetchImpl(`${this.baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`createWorkspace failed: ${res.status}`);
    return workspace.parse(await res.json());
  }
}
