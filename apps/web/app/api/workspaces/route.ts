// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { createWorkspaceRequest } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";

import { authenticate, badRequest, forbidden, isResponse } from "../../../lib/api";
import { getControlPlane } from "../../../lib/control-plane";

// GET /api/workspaces — admins see all; everyone else sees their own.
export async function GET(req: Request) {
  const principal = authenticate(req);
  if (isResponse(principal)) return principal;

  const cp = await getControlPlane();
  const workspaces =
    principal.role === "admin" ? await cp.list() : await cp.list({ ownerId: principal.id });
  return NextResponse.json({ workspaces });
}

// POST /api/workspaces — create a workspace owned by the caller.
export async function POST(req: Request) {
  const principal = authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can("create", "Workspace")) return forbidden();

  let body;
  try {
    body = createWorkspaceRequest.parse(await req.json());
  } catch {
    return badRequest();
  }

  const cp = await getControlPlane();
  const workspace = await cp.create({ ownerId: principal.id, baseImage: body.baseImage });
  return NextResponse.json(workspace, { status: 201 });
}
