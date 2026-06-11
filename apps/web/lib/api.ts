// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor, type Action, type Principal } from "@edd/authz";
import type { WorkspaceService } from "@edd/control-plane";
import { domainErrorMessage, workspaceId, type DomainError, type WorkspaceId } from "@edd/core";

import { getControlPlane } from "./control-plane";
import { checkGatewayAuth } from "./machine-auth";
import { getPrincipal } from "./principal";

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
export const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });
export const badRequest = (message = "invalid request") =>
  NextResponse.json({ error: message }, { status: 400 });
export const conflict = (message: string) => NextResponse.json({ error: message }, { status: 409 });

/** Narrow an unknown thrown value to a message without an assertion. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The ONE place a domain failure becomes an HTTP status. `Record<…kind, number>`
// is total, so adding a `DomainError` kind without a status here is a compile
// error — routes never hand-map errors, and none can be forgotten.
const DOMAIN_ERROR_STATUS: Record<DomainError["kind"], number> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
};

/** Map a `DomainError` (the typed failure channel) to its HTTP response. */
export function domainErrorResponse(error: DomainError): NextResponse {
  return NextResponse.json(
    { error: domainErrorMessage(error) },
    { status: DOMAIN_ERROR_STATUS[error.kind] },
  );
}

/** Resolve the principal or return a 401 response to short-circuit the handler. */
export async function authenticate(req: Request): Promise<Principal | NextResponse> {
  return (await getPrincipal(req)) ?? unauthorized();
}

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}

/** Admins act on any workspace; everyone else only on their own. */
function ownsOrAdmin(principal: Principal, ownerId: string): boolean {
  return principal.role === "admin" || principal.id === ownerId;
}

interface OwnedWorkspace {
  cp: WorkspaceService;
  id: WorkspaceId;
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
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!defineAbilityFor(principal).can(action, "Workspace")) return forbidden();

  const { id } = await params;
  const wsId = workspaceId(id);
  const cp = await getControlPlane();
  const ws = await cp.get(wsId);
  if (!ws) return notFound();
  if (!ownsOrAdmin(principal, ws.ownerId)) return forbidden();
  return { cp, id: wsId, ws };
}

/**
 * Like {@link loadOwnedWorkspace}, but additionally accepts the SSH gateway's
 * per-workspace machine-auth token (`Authorization: Bearer <HMAC>`, secret in
 * `EDD_GATEWAY_SECRET`) — the gateway is a service process with no Auth.js
 * session. Only the wake-on-connect read/wake routes use this; destructive
 * routes (delete, stop, …) stay session-only.
 */
export async function loadConnectableWorkspace(
  req: Request,
  params: Promise<{ id: string }>,
  action: Action,
): Promise<OwnedWorkspace | NextResponse> {
  const { id } = await params;
  const gateway = checkGatewayAuth(req, id);
  if (gateway === "invalid") return unauthorized();
  if (gateway === "valid") {
    const wsId = workspaceId(id);
    const cp = await getControlPlane();
    const ws = await cp.get(wsId);
    if (!ws) return notFound();
    return { cp, id: wsId, ws };
  }
  // No machine credential presented — normal session auth applies.
  return loadOwnedWorkspace(req, params, action);
}
