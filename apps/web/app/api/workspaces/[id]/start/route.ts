// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";
import { auditActor, recordAudit } from "../../../../../lib/audit";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/start — wake from snapshot (hydrate + run).
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.start(ctx.id);
  if (!result.ok) return domainErrorResponse(result.error);
  if (ctx.principal !== undefined) {
    await recordAudit({
      actor: auditActor(ctx.principal),
      action: "session.start",
      target: ctx.id,
      detail: "woken from snapshot",
    });
  }
  return NextResponse.json(result.value);
}
