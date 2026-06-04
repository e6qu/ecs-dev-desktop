// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../lib/api";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/workspaces/:id — the caller's own workspace (admins, any).
export async function GET(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;
  return NextResponse.json(ctx.ws);
}

// DELETE /api/workspaces/:id — remove() returns a typed Result; the central mapper
// turns a domain failure into its status (a concurrent double-delete → not_found →
// 404), so a racy delete can never escape as a 500.
export async function DELETE(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "delete");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.remove(ctx.id);
  return result.ok ? new NextResponse(null, { status: 204 }) : domainErrorResponse(result.error);
}
