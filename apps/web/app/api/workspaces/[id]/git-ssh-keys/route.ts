// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { workspaceGitSshKeysResponse } from "@edd/api-contracts";
import { ownerId } from "@edd/core";

import { isResponse, type IdRouteContext } from "../../../../../lib/api";
import { gitIntegration } from "../../../../../lib/git-integration";
import { getGitSshKeys } from "../../../../../lib/git-credentials";
import { gitHostKnownHosts } from "../../../../../lib/github";
import { withObservability } from "../../../../../lib/observability";
import { loadBrokeredWorkspace } from "../../../../../lib/workspace-broker";

/**
 * GET /api/workspaces/:id/git-ssh-keys — the boot-time broker for the owner's
 * platform-generated git SSH keys, private halves included, fetched by the workspace over
 * the idle-agent's HMAC machine-auth. Agent-only: there is NO session fallback, so only the
 * workspace itself can fetch them, and the private keys never reach the browser or task
 * metadata. The workspace writes them to tmpfs (never the volume) with an ssh_config for
 * the git host, plus the host's published host keys for `known_hosts` when it publishes
 * any. The agent-auth and lifecycle gate is `loadBrokeredWorkspace`.
 */
async function handleGET(req: Request, { params }: IdRouteContext) {
  const { id } = await params;
  const ws = await loadBrokeredWorkspace(req, id);
  if (isResponse(ws)) return ws;

  const integration = gitIntegration();
  // Keys are simply off on a deployment without the store: an empty 204, like the
  // git-credential broker's "no credential", so the workspace knows there is nothing to
  // wait for rather than treating it as a broker failure.
  if (!integration.sshKeys) return new NextResponse(null, { status: 204 });
  const materials = await getGitSshKeys().materials(ownerId(ws.ownerId));
  if (materials.length === 0) return new NextResponse(null, { status: 204 });

  const body = workspaceGitSshKeysResponse.parse({
    host: integration.host,
    knownHosts: await gitHostKnownHosts(integration.apiUrl, integration.host),
    keys: materials.map((key) => ({
      id: key.id,
      label: key.label,
      publicKey: key.publicKey,
      privateKey: key.privateKey,
    })),
  });
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

export const GET = withObservability("workspaces.gitSshKeys", handleGET);
