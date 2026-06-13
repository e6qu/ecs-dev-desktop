// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import {
  domainErrorResponse,
  isResponse,
  loadConnectableWorkspace,
  loadOwnedWorkspace,
} from "../../../../lib/api";
import { auditActor } from "../../../../lib/audit";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/workspaces/:id — the caller's own workspace (admins, any). Also
// accepts the SSH gateway's machine-auth token: the gateway polls this route
// for `state` while waking a workspace on connect.
export async function GET(req: Request, { params }: Ctx) {
  const ctx = await loadConnectableWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;
  return NextResponse.json(ctx.ws);
}

// DELETE /api/workspaces/:id — remove() returns a typed Result; the central mapper
// turns a domain failure into its status (a concurrent double-delete → not_found →
// 404), so a racy delete can never escape as a 500.
export async function DELETE(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "delete");
  if (isResponse(ctx)) return ctx;
  // The control plane records `session.delete` (attributed to the caller, or to
  // `system` for a machine-auth delete) — see workspaces/route.ts.
  const result = await ctx.cp.remove(
    ctx.id,
    ctx.principal === undefined ? undefined : auditActor(ctx.principal),
  );
  if (!result.ok) return domainErrorResponse(result.error);
  return new NextResponse(null, { status: 204 });
}
