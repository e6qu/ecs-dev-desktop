// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { heartbeatRequest } from "@edd/api-contracts";
import { workspaceId } from "@edd/core";

import { checkAgentAuth } from "../../../../../lib/machine-auth";
import {
  domainErrorResponse,
  isResponse,
  loadOwnedWorkspace,
  notFound,
} from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Optional self-reports: functional (IDE reachable + workspace writable) and
 * activity (real usage since the last beat vs merely alive). Best-effort on BOTH
 * auth paths: a missing/malformed body just means a plain activity heartbeat. */
async function parseReport(
  req: Request,
): Promise<{ functional?: { ide: boolean; workspace: boolean }; active?: boolean } | undefined> {
  try {
    const parsed = heartbeatRequest.parse(await req.json());
    return {
      ...(parsed.functional !== undefined ? { functional: parsed.functional } : {}),
      ...(parsed.active !== undefined ? { active: parsed.active } : {}),
    };
  } catch {
    return undefined;
  }
}

// POST /api/workspaces/:id/heartbeat — reports in-workspace liveness + activity so
// the reconciler keeps a USED workspace running (an `active: false` beat records
// liveness without refreshing the idle window). Accepts two auth paths:
//   1. Session auth (browser / API client with Auth.js session cookie)
//   2. Agent machine-auth: Authorization: Bearer <HMAC-SHA256(secret, wsId)>
//      — used by the idle-agent running inside the workspace container.
async function handlePOST(req: Request, { params }: Ctx) {
  const { id } = await params;

  const agentResult = checkAgentAuth(req, id);
  if (agentResult === "invalid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (agentResult === "valid") {
    const cp = await getControlPlane();
    const ws = await cp.get(workspaceId(id));
    if (!ws) return notFound();
    const result = await cp.heartbeat(workspaceId(id), await parseReport(req));
    return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
  }

  // agentResult === "absent" — fall through to session auth. The self-reports are
  // honoured here too (a browser/API client may send them), not only on the agent path.
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.heartbeat(ctx.id, await parseReport(req));
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

export const POST = withObservability("workspaces.heartbeat", handlePOST);
