// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/start — wake from snapshot (hydrate + run). The
// control plane records `session.start` on the wake transition (see
// workspaces/route.ts) — attributed to the caller, or `system` if machine-auth.
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.start(
    ctx.id,
    ctx.principal === undefined ? undefined : auditActor(ctx.principal),
  );
  if (!result.ok) return domainErrorResponse(result.error);
  return NextResponse.json(result.value);
}
