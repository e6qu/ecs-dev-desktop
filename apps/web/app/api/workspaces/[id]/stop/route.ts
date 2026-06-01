// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { conflict, errorMessage, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/stop — scale to zero (snapshot + tear down).
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  try {
    return NextResponse.json(await ctx.cp.stop(ctx.id));
  } catch (err) {
    return conflict(errorMessage(err));
  }
}
