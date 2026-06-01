// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { createWorkspaceRequest } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { baseImage, ownerId } from "@edd/core";

import { authenticate, badRequest, forbidden, isResponse } from "../../../lib/api";
import { getControlPlane } from "../../../lib/control-plane";

// GET /api/workspaces — admins see all; everyone else sees their own.
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const cp = await getControlPlane();
  const workspaces =
    principal.role === "admin"
      ? await cp.list()
      : await cp.list({ ownerId: ownerId(principal.id) });
  return NextResponse.json({ workspaces });
}

// POST /api/workspaces — create a workspace owned by the caller.
export async function POST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can("create", "Workspace")) return forbidden();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = createWorkspaceRequest.safeParse(raw);
  if (!parsed.success) return badRequest();

  const cp = await getControlPlane();
  const workspace = await cp.create({
    ownerId: ownerId(principal.id),
    baseImage: baseImage(parsed.data.baseImage),
  });
  return NextResponse.json(workspace, { status: 201 });
}
