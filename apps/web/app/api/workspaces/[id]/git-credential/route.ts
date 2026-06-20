// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { ownerId, workspaceId } from "@edd/core";

import { notFound } from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { getGitProvider } from "../../../../../lib/git-provider";
import { checkAgentAuth } from "../../../../../lib/machine-auth";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** The owner login from an `https://host/owner/repo(.git)` URL, for picking the
 * right GitHub App installation; undefined when there is no/odd repo URL. */
function repoOwner(repoUrl: string | undefined): string | undefined {
  if (repoUrl === undefined) return undefined;
  try {
    const segments = new URL(repoUrl).pathname.split("/").filter((s) => s.length > 0);
    return segments[0];
  } catch {
    return undefined;
  }
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

  const provider = await getGitProvider(ownerId(ws.ownerId));
  const credential = provider === null ? null : await provider.gitCredential(repoOwner(ws.repoUrl));
  if (credential === null) {
    return NextResponse.json({ error: "no credential" }, { status: 404 });
  }
  return NextResponse.json(credential);
}

export const GET = withObservability("workspaces.gitCredential", handleGET);
