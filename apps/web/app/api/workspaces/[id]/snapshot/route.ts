// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { conflict, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/workspaces/:id/snapshot — point-in-time snapshot.
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  try {
    return NextResponse.json(await ctx.cp.snapshot(ctx.id));
  } catch (err) {
    return conflict((err as Error).message);
  }
}
