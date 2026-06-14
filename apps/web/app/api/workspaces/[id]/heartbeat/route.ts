// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { workspaceId } from "@edd/core";

import { checkAgentAuth } from "../../../../../lib/machine-auth";
import {
  domainErrorResponse,
  isResponse,
  loadOwnedWorkspace,
  notFound,
} from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/heartbeat — reports in-workspace activity so the
// reconciler keeps the workspace running. Accepts two auth paths:
//   1. Session auth (browser / API client with Auth.js session cookie)
//   2. Agent machine-auth: Authorization: Bearer <HMAC-SHA256(secret, wsId)>
//      — used by the idle-agent running inside the workspace container.
async function handlePOST(req: Request, { params }: Ctx) {
  const { id } = await params;

  const agentResult = checkAgentAuth(req, id);
  if (agentResult === "invalid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (agentResult === "valid") {
    const cp = await getControlPlane();
    const ws = await cp.get(workspaceId(id));
    if (!ws) return notFound();
    const result = await cp.heartbeat(workspaceId(id));
    return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
  }

  // agentResult === "absent" — fall through to session auth.
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.heartbeat(ctx.id);
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

export const POST = withObservability("workspaces.heartbeat", handlePOST);
