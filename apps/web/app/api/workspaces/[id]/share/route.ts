// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { shareRequest } from "@edd/api-contracts";

import { domainErrorResponse, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/share {enabled} — toggle the owner's spectate flag.
// Session-only and OWNER-only ("update" grant): sharing exposes the live session
// (including keystrokes) to every signed-in viewer, so nobody but the owner may
// enable it — an admin can inspect through the admin surface, not impersonate a
// share decision. Disabling is always accepted for the same principal.
async function handlePOST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const parsed = shareRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "body must be {enabled: boolean}" }, { status: 400 });
  }
  const result = await ctx.cp.setShare(
    ctx.id,
    parsed.data.enabled,
    ctx.principal === undefined ? undefined : auditActor(ctx.principal),
  );
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

export const POST = withObservability("workspaces.share", handlePOST);
