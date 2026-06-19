// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { securityEventRequest } from "@edd/api-contracts";
import { workspaceId } from "@edd/core";

import { badRequest, domainErrorResponse, notFound } from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { checkAgentAuth } from "../../../../../lib/machine-auth";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/security-event — the in-workspace privilege guard reports a
// blocked privileged-tool attempt (docker, sudo, …). Agent machine-auth only (the same
// HMAC bearer the idle-agent uses); a browser/session has no reason to call this. The
// control plane records a first-class audit event + emits the security metric, so the
// attempt surfaces in admin monitoring (audit/Logs view, dashboard, alarm).
async function handlePOST(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (checkAgentAuth(req, id) !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = securityEventRequest.safeParse(raw);
  if (!parsed.success) return badRequest();

  const cp = await getControlPlane();
  if (!(await cp.get(workspaceId(id)))) return notFound();
  const result = await cp.recordSecurityEvent(workspaceId(id), parsed.data);
  if (!result.ok) return domainErrorResponse(result.error);
  return new NextResponse(null, { status: 202 });
}

export const POST = withObservability("workspaces.security_event", handlePOST);
