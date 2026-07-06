// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { withObservability } from "./observability";

import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor, type Action, type Principal } from "@edd/authz";
import type { WorkspaceService } from "@edd/control-plane";
import {
  domainErrorMessage,
  workspaceId,
  type DomainError,
  type Result,
  type WorkspaceId,
} from "@edd/core";

import { getControlPlane } from "./control-plane";
import { checkGatewayAuth } from "./machine-auth";
import { getPrincipal } from "./principal";

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
export const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });
export const badRequest = (message = "invalid request") =>
  NextResponse.json({ error: message }, { status: 400 });
export const conflict = (message: string) => NextResponse.json({ error: message }, { status: 409 });

// The ONE place a domain failure becomes an HTTP status. `Record<…kind, number>`
// is total, so adding a `DomainError` kind without a status here is a compile
// error — routes never hand-map errors, and none can be forgotten.
const DOMAIN_ERROR_STATUS: Record<DomainError["kind"], number> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  unavailable: 503,
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

/** Resolve an **admin** principal, or a 401/403 response to short-circuit the
 * handler. The single guard the admin-only routes share. */
export async function requireAdmin(req: Request): Promise<Principal | NextResponse> {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();
  return principal;
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
  /** The acting principal for session auth; absent for machine-auth (gateway). */
  principal?: Principal;
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
  return { cp, id: wsId, ws, principal };
}

/**
 * Load an owned workspace (`update` ability) and run a `Result`-returning
 * control-plane action against it, mapping the outcome to a JSON response or the
 * domain error's HTTP status. The shared shape of the start/stop/snapshot
 * lifecycle routes — the `run` callback supplies the specific action (and actor).
 */
/** Like {@link loadOwnedWorkspace} but also resolves the FULL detail record
 * (runtime bindings: taskId/volumeId/disk figures) — the shape the owner-facing
 * logs/monitoring routes need. 404s when the record vanished between the authz
 * read and the inspect. */
export async function loadOwnedWorkspaceDetail(
  req: Request,
  params: Promise<{ id: string }>,
): Promise<{ ctx: OwnedWorkspace; detail: WorkspaceDetail } | NextResponse> {
  const ctx = await loadOwnedWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;
  const detail = await ctx.cp.inspect(ctx.id);
  if (detail === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return { ctx, detail };
}

type WorkspaceDetail = NonNullable<Awaited<ReturnType<OwnedWorkspace["cp"]["inspect"]>>>;

/**
 * The POST handler for a one-verb owned-lifecycle route (start/stop/snapshot/
 * retry/...): the same authz + Result-mapping shell, differing only in the
 * observability name and which service call runs. Collapses the per-route
 * boilerplate the tiny route files would otherwise clone.
 */
export function lifecyclePOST(
  name: string,
  run: (ctx: OwnedWorkspace) => Promise<Result<WorkspaceDto, DomainError>>,
) {
  return withObservability(name, (req: Request, { params }: { params: Promise<{ id: string }> }) =>
    ownedLifecycleAction(req, params, run),
  );
}

async function ownedLifecycleAction(
  req: Request,
  params: Promise<{ id: string }>,
  run: (ctx: OwnedWorkspace) => Promise<Result<WorkspaceDto, DomainError>>,
): Promise<NextResponse> {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await run(ctx);
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
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
