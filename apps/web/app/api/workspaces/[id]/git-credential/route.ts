// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { workspaceId } from "@edd/core";

import { notFound } from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { getGitCredentials, gitCredentialsEnabled } from "../../../../../lib/git-credentials";
import { checkAgentAuth } from "../../../../../lib/machine-auth";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/workspaces/:id/git-credential — the in-workspace git credential
 * helper fetches the session owner's git token (to clone/push private repos)
 * over the idle-agent's HMAC machine-auth. Agent-only: there is NO session
 * fallback, so only the workspace itself can fetch its owner's credential, and
 * the token is never placed in task metadata or exposed to the browser.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (checkAgentAuth(req, id) !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!gitCredentialsEnabled()) {
    return NextResponse.json({ error: "git credentials not configured" }, { status: 404 });
  }
  const cp = await getControlPlane();
  const ws = await cp.get(workspaceId(id));
  if (!ws) return notFound();

  const token = await getGitCredentials().fetch(ws.ownerId);
  if (token === null) {
    return NextResponse.json({ error: "no credential" }, { status: 404 });
  }
  return NextResponse.json({ username: "x-access-token", token });
}
