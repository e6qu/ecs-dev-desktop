// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { gitCredentialResponse } from "@edd/api-contracts";
import { ownerId, workspaceId } from "@edd/core";

import { notFound } from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { getGitProvider } from "../../../../../lib/git-provider";
import { repoRef } from "../../../../../lib/git-remote";
import { checkAgentAuth } from "../../../../../lib/machine-auth";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/workspaces/:id/git-credential — the in-workspace git credential
 * helper fetches a git token (to clone/push private repos) over the idle-agent's
 * HMAC machine-auth. Agent-only: there is NO session fallback, so only the
 * workspace itself can fetch its credential, and the token is never placed in
 * task metadata or exposed to the browser. The credential comes from the active
 * provider — the session owner's OAuth token, or a GitHub App installation token
 * scoped to the repo's owner when the app is configured.
 */
async function handleGET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (checkAgentAuth(req, id) !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const cp = await getControlPlane();
  const ws = await cp.get(workspaceId(id));
  if (!ws) return notFound();
  // Never mint a live git credential for a workspace that is being torn down. `get`
  // returns the `deleting` tombstone (and a `terminated` record) too, so without this
  // gate a lingering container whose deletion is in flight could keep pulling tokens.
  // Every other lifecycle decision refuses to act on a tombstone (snapshot guards it,
  // planConnect maps `deleting`→unavailable); this is the one secret-emitting route.
  if (ws.state === "deleting" || ws.state === "terminated") return notFound();

  const provider = await getGitProvider(ownerId(ws.ownerId));
  const credential = provider === null ? null : await provider.gitCredential(repoRef(ws.repoUrl));
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
