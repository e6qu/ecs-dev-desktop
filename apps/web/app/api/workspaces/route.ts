// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { createWorkspaceRequest } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { baseImage, email, ownerId, withinWorkspaceQuota } from "@edd/core";

import {
  authenticate,
  badRequest,
  conflict,
  domainErrorResponse,
  forbidden,
  isResponse,
} from "../../../lib/api";
import { getCatalog, getControlPlane } from "../../../lib/control-plane";
import { workspaceLimit } from "../../../lib/quota";

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

  const image = baseImage(parsed.data.baseImage);
  // Workspaces may only launch from an enabled catalog entry (the allow-list).
  const enabled = await getCatalog().assertEnabled(image);
  if (!enabled.ok) return domainErrorResponse(enabled.error);

  const cp = await getControlPlane();

  // Enforce the per-role workspace quota.
  const owned = await cp.list({ ownerId: ownerId(principal.id) });
  if (!withinWorkspaceQuota(owned.length, workspaceLimit(principal.role))) {
    return conflict(`workspace quota reached (${owned.length.toString()})`);
  }

  // Record the owner's email (when the session carries one) so the proxy can
  // match a caller to this workspace; a malformed value is dropped, not fatal.
  let ownerEmail;
  try {
    ownerEmail = principal.email === undefined ? undefined : email(principal.email);
  } catch {
    ownerEmail = undefined;
  }
  const workspace = await cp.create({
    ownerId: ownerId(principal.id),
    ...(ownerEmail === undefined ? {} : { ownerEmail }),
    ...(parsed.data.repoUrl === undefined ? {} : { repoUrl: parsed.data.repoUrl }),
    ...(parsed.data.repoRef === undefined ? {} : { repoRef: parsed.data.repoRef }),
    baseImage: image,
  });
  return NextResponse.json(workspace, { status: 201 });
}
