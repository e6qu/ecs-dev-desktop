// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/purge — PERMANENTLY delete a terminated (deleted)
// workspace before its 7-day retention purge: reaps the retained snapshot and
// removes the record for good (irreversible). Owner-or-admin ("delete" grant).
// The destructive-confirm UX (type-to-confirm) is enforced client-side; only a
// `terminated` workspace is purgeable (the service rejects anything else).
async function handlePOST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "delete");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.purgeNow(
    ctx.id,
    ctx.principal === undefined ? undefined : auditActor(ctx.principal),
  );
  if (!result.ok) return domainErrorResponse(result.error);
  return new NextResponse(null, { status: 202 });
}

export const POST = withObservability("workspaces.purge", handlePOST);
