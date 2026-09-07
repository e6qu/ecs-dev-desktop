// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { gitCredentialResponse } from "@edd/api-contracts";
import { ownerId, parseGitRemote, repoRef } from "@edd/core";

import { isResponse, type IdRouteContext } from "../../../../../lib/api";
import { getGitProvider } from "../../../../../lib/git-provider";
import { withObservability } from "../../../../../lib/observability";
import { loadBrokeredWorkspace } from "../../../../../lib/workspace-broker";

/**
 * GET /api/workspaces/:id/git-credential — the in-workspace git credential
 * helper fetches a git token (to clone/push private repos) over the idle-agent's
 * HMAC machine-auth. Agent-only: there is NO session fallback, so only the
 * workspace itself can fetch its credential, and the token is never placed in
 * task metadata or exposed to the browser. The credential comes from the active
 * provider — the session owner's OAuth token, or a GitHub App installation token
 * scoped to the repo's owner when the app is configured. The agent-auth and lifecycle
 * gate is `loadBrokeredWorkspace`.
 */
async function handleGET(req: Request, { params }: IdRouteContext) {
  const { id } = await params;
  const ws = await loadBrokeredWorkspace(req, id);
  if (isResponse(ws)) return ws;
  const provider = await getGitProvider(ownerId(ws.ownerId));
  const remote = ws.repoUrl === undefined ? undefined : (parseGitRemote(ws.repoUrl) ?? undefined);
  const credential = provider === null ? null : await provider.gitCredential(repoRef(remote));
  // "No credential for this session" is a normal, non-error answer (a public-repo session
  // whose owner never linked a Git account): 204, so the in-workspace helper can tell it
  // from a 404 (the workspace is gone) and tell the user to link an account rather than
  // reporting a broker failure.
  if (credential === null) return new NextResponse(null, { status: 204 });
  // Guarantee the on-the-wire shape against the contract (the one API body that
  // was emitted unvalidated) before the in-workspace helper consumes it.
  return NextResponse.json(gitCredentialResponse.parse(credential));
}

export const GET = withObservability("workspaces.gitCredential", handleGET);
