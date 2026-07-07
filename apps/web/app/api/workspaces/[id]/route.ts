// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { updateWorkspaceRequest } from "@edd/api-contracts";

import {
  badRequest,
  domainErrorResponse,
  forbidden,
  isResponse,
  loadConnectableWorkspace,
  loadOwnedWorkspace,
} from "../../../../lib/api";
import { auditActor } from "../../../../lib/audit";
import { withObservability } from "../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/workspaces/:id — the caller's own workspace (admins, any). Also
// accepts the SSH gateway's machine-auth token: the gateway polls this route
// for `state` while waking a workspace on connect.
async function handleGET(req: Request, { params }: Ctx) {
  const ctx = await loadConnectableWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;
  return NextResponse.json(ctx.ws);
}

// DELETE /api/workspaces/:id — marks the workspace for deletion (the `deleting`
// tombstone); the reconciler converges teardown and removes the record. Async by
// design, so it returns 202 Accepted (not 204). remove() returns a typed Result; the
// central mapper turns a domain failure into its status (so a racy delete never 500s).
async function handleDELETE(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "delete");
  if (isResponse(ctx)) return ctx;
  // The control plane records `session.delete` (attributed to the caller, or to
  // `system` for a machine-auth delete) — see workspaces/route.ts.
  const result = await ctx.cp.remove(
    ctx.id,
    ctx.principal === undefined ? undefined : auditActor(ctx.principal),
  );
  if (!result.ok) return domainErrorResponse(result.error);
  return new NextResponse(null, { status: 202 });
}

// PATCH /api/workspaces/:id — owner/admin workspace settings.
async function handlePATCH(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = updateWorkspaceRequest.safeParse(raw);
  if (!parsed.success) return badRequest();
  if (ctx.principal === undefined) return forbidden();
  const result = await ctx.cp.updateSettings(ctx.id, parsed.data, auditActor(ctx.principal));
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

export const GET = withObservability("workspaces.get", handleGET);
export const PATCH = withObservability("workspaces.update", handlePATCH);
export const DELETE = withObservability("workspaces.delete", handleDELETE);
