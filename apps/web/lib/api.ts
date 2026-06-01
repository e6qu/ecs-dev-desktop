// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor, type Action, type Principal } from "@edd/authz";
import type { WorkspaceService } from "@edd/control-plane";

import { getControlPlane } from "./control-plane";
import { getPrincipal } from "./principal";

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
export const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });
export const badRequest = (message = "invalid request") =>
  NextResponse.json({ error: message }, { status: 400 });
export const conflict = (message: string) => NextResponse.json({ error: message }, { status: 409 });

/** Resolve the principal or return a 401 response to short-circuit the handler. */
export function authenticate(req: Request): Principal | NextResponse {
  return getPrincipal(req) ?? unauthorized();
}

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}

/** Admins act on any workspace; everyone else only on their own. */
export function ownsOrAdmin(principal: Principal, ownerId: string): boolean {
  return principal.role === "admin" || principal.id === ownerId;
}

export interface OwnedWorkspace {
  cp: WorkspaceService;
  id: string;
  ws: WorkspaceDto;
}

/**
 * Authenticate, authorize (`action` on Workspace + ownership), and load the
 * target workspace. Returns the loaded context or a short-circuit Response.
 */
export async function loadOwnedWorkspace(
  req: Request,
  params: Promise<{ id: string }>,
  action: Action,
): Promise<OwnedWorkspace | NextResponse> {
  const principal = authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can(action, "Workspace")) return forbidden();

  const { id } = await params;
  const cp = await getControlPlane();
  const ws = await cp.get(id);
  if (!ws) return notFound();
  if (!ownsOrAdmin(principal, ws.ownerId)) return forbidden();
  return { cp, id, ws };
}
