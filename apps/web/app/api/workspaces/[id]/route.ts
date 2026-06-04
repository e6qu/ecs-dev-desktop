// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { defineAbilityFor } from "@edd/authz";
import { WorkspaceNotFoundError } from "@edd/control-plane";
import { workspaceId } from "@edd/core";

import {
  authenticate,
  conflict,
  errorMessage,
  forbidden,
  isResponse,
  notFound,
  ownsOrAdmin,
} from "../../../../lib/api";
import { getControlPlane } from "../../../../lib/control-plane";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/workspaces/:id
export async function GET(req: Request, { params }: Ctx) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const { id } = await params;
  const ws = await (await getControlPlane()).get(workspaceId(id));
  if (!ws) return notFound();
  if (!ownsOrAdmin(principal, ws.ownerId)) return forbidden();
  return NextResponse.json(ws);
}

// DELETE /api/workspaces/:id
export async function DELETE(req: Request, { params }: Ctx) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can("delete", "Workspace")) return forbidden();

  const { id } = await params;
  const wsId = workspaceId(id);
  const cp = await getControlPlane();
  const ws = await cp.get(wsId);
  if (!ws) return notFound();
  if (!ownsOrAdmin(principal, ws.ownerId)) return forbidden();

  // Map domain errors like the lifecycle routes (no bare 500s): a concurrent
  // double-delete re-fetches a now-missing workspace (404); a non-terminable
  // state (e.g. already terminated) is a conflict (409).
  try {
    await cp.remove(wsId);
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return notFound();
    return conflict(errorMessage(err));
  }
  return new NextResponse(null, { status: 204 });
}
