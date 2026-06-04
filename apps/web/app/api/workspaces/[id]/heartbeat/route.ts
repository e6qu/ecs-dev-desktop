// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/heartbeat — the in-workspace idle-agent reports activity
// (editor/terminal/SSH), refreshing lastActivity so the reconciler keeps it running.
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.heartbeat(ctx.id);
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}
