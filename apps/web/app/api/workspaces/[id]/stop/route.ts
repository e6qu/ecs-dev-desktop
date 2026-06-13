// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";
import { auditActor, recordAudit } from "../../../../../lib/audit";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/stop — scale to zero (snapshot + tear down).
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.stop(ctx.id);
  if (!result.ok) return domainErrorResponse(result.error);
  if (ctx.principal !== undefined) {
    await recordAudit({
      actor: auditActor(ctx.principal),
      action: "session.stop",
      target: ctx.id,
      detail: "scaled to zero",
    });
  }
  return NextResponse.json(result.value);
}
