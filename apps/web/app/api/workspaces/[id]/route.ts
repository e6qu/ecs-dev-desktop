// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { defineAbilityFor } from "@edd/authz";
import { workspaceId } from "@edd/core";

import {
  authenticate,
  domainErrorResponse,
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

  // remove() returns a typed Result; the central mapper turns a domain failure
  // into its status (a concurrent double-delete → not_found → 404), so a racy
  // delete can never escape as a 500.
  const result = await cp.remove(wsId);
  return result.ok ? new NextResponse(null, { status: 204 }) : domainErrorResponse(result.error);
}
