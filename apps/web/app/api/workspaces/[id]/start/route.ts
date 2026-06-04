// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/start — wake from snapshot (hydrate + run).
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.start(ctx.id);
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}
