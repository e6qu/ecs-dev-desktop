// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { createWorkspaceRequest } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { ComputeUnavailableError } from "@edd/control-plane";
import { baseImage, ownerId, unavailableError, withinWorkspaceQuota } from "@edd/core";

import {
  authenticate,
  badRequest,
  conflict,
  domainErrorResponse,
  forbidden,
  isResponse,
} from "../../../lib/api";
import { getCatalog, getControlPlane } from "../../../lib/control-plane";
import { getMetrics } from "../../../lib/metrics";
import { resolveOwnerEmail } from "../../../lib/owner-email";
import { devAuthEnabled } from "../../../lib/principal";
import { withObservability } from "../../../lib/observability";
import { workspaceLimit } from "../../../lib/quota";
import { recordQuotaUsage } from "../../../lib/quota-metrics";

// GET /api/workspaces — admins see all; everyone else sees their own.
async function handleGET(req: Request) {
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
async function handlePOST(req: Request) {
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

  // Enforce the per-role workspace quota, and emit the per-role utilization gauge
  // (plus a denial count when rejected) — the create path is the one place that
  // knows both the owner's current count and their role-derived limit.
  const owned = await cp.list({ ownerId: ownerId(principal.id) });
  const limit = workspaceLimit(principal.role);
  const allowed = withinWorkspaceQuota(owned.length, limit);
  recordQuotaUsage(getMetrics(), { owned: owned.length, limit, role: principal.role, allowed });
  if (!allowed) {
    return conflict(`workspace quota reached (${owned.length.toString()})`);
  }

  // Record the owner's email so the proxy can match a caller to this workspace. A
  // present email must be valid (never silently dropped — §6.5) and a real (non-dev)
  // session with no email is rejected, since the workspace would be unopenable via the
  // proxy — better a clear 400 now than a created-but-inaccessible workspace.
  const ownerEmailResult = resolveOwnerEmail(principal.email, devAuthEnabled());
  if (!ownerEmailResult.ok) return badRequest(ownerEmailResult.reason);
  const ownerEmail = ownerEmailResult.email;
  let workspace;
  try {
    workspace = await cp.create({
      ownerId: ownerId(principal.id),
      ...(ownerEmail === undefined ? {} : { ownerEmail }),
      ...(parsed.data.repoUrl === undefined ? {} : { repoUrl: parsed.data.repoUrl }),
      ...(parsed.data.repoRef === undefined ? {} : { repoRef: parsed.data.repoRef }),
      baseImage: image,
    });
  } catch (e) {
    // The compute backend couldn't launch the task — a handled, retryable failure
    // (→ 503), not an unexpected 500. Anything else is genuinely unexpected: rethrow.
    if (e instanceof ComputeUnavailableError) {
      return domainErrorResponse(unavailableError(e.message));
    }
    throw e;
  }
  // The control plane records `session.create` to the audit ledger (attributed
  // to the owner), so the cost model and admin feed see it without a route-level
  // emit. Same for start/stop/delete on their routes.
  return NextResponse.json(workspace, { status: 201 });
}

export const GET = withObservability("workspaces.list", handleGET);
export const POST = withObservability("workspaces.create", handlePOST);
