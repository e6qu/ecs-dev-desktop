// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { conflict, errorMessage, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/workspaces/:id/start — wake from snapshot (hydrate + run).
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  try {
    return NextResponse.json(await ctx.cp.start(ctx.id));
  } catch (err) {
    return conflict(errorMessage(err));
  }
}
