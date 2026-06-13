// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";

import { WORKSPACE_BASE_DOMAIN } from "@edd/config";
import { workspaceIdFromHost } from "@edd/core";

/**
 * Dynamic per-workspace upstream resolution for the gate: derive the workspace
 * id from the request Host, wake the workspace (idempotent), and resolve its
 * live OpenVSCode address via the control-plane connect-info — so one gate
 * fronts every workspace (Pomerium's single static upstream) and routes each by
 * subdomain, waking scaled-to-zero sessions on connect (the browser path's
 * "reopen → session comes back").
 */

/** Per-workspace gateway HMAC token (matches the control-plane machine-auth):
 * HMAC-SHA256(hex(secret), workspaceId). Per-workspace, so a token cannot act on
 * another workspace. */
export function gatewayToken(secretHex: string, workspaceId: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(workspaceId).digest("hex");
}

export interface ResolverConfig {
  /** Control-plane base URL (for /connect and /connect-info). */
  readonly controlPlaneUrl: string;
  /** Gateway machine-auth secret (hex). */
  readonly gatewaySecretHex: string;
  /** Base domain for `<ws-id>.<baseDomain>` (defaults to the configured one). */
  readonly baseDomain?: string;
  /** Injectable fetch (tests). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build a resolver `(host) => upstreamUrl`. Wakes the workspace then returns its
 * live `http://<eni>:<port>`. Throws (gate fails closed → 502) for a non-
 * workspace host or any control-plane failure.
 */
export function makeUpstreamResolver(cfg: ResolverConfig): (host: string) => Promise<string> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const baseDomain = cfg.baseDomain ?? WORKSPACE_BASE_DOMAIN;
  return async (host: string): Promise<string> => {
    const wsId = workspaceIdFromHost(host, baseDomain);
    if (wsId === undefined) throw new Error(`not a workspace host: ${host}`);
    const headers = { authorization: `Bearer ${gatewayToken(cfg.gatewaySecretHex, wsId)}` };

    const wake = await doFetch(`${cfg.controlPlaneUrl}/api/workspaces/${wsId}/connect`, {
      method: "POST",
      headers,
    });
    if (!wake.ok) throw new Error(`wake failed: ${String(wake.status)}`);

    const info = await doFetch(
      `${cfg.controlPlaneUrl}/api/workspaces/${wsId}/connect-info?protocol=http`,
      { headers },
    );
    if (!info.ok) throw new Error(`connect-info failed: ${String(info.status)}`);

    const body = (await info.json()) as { host: string; port: number };
    return `http://${body.host}:${String(body.port)}`;
  };
}
