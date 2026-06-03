// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { conflict, errorMessage, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/connect — wake-on-connect: ensure the workspace is
// reachable (idempotent), waking it from its snapshot if it is scaled to zero.
// Invoked by the connection path (e.g. the SSH gateway) before forwarding.
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  try {
    return NextResponse.json(await ctx.cp.connect(ctx.id));
  } catch (err) {
    return conflict(errorMessage(err));
  }
}
