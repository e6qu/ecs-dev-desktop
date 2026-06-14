// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, loadConnectableWorkspace } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/connect — wake-on-connect: ensure the workspace is
// reachable (idempotent), waking it from its snapshot if it is scaled to zero.
// Invoked by the connection path (e.g. the SSH gateway) before forwarding;
// accepts the gateway's machine-auth token as well as a user session. The
// control plane records `session.start` only when this actually wakes a
// scaled-to-zero workspace — idempotent reconnects log nothing (no flood).
async function handlePOST(req: Request, { params }: Ctx) {
  const ctx = await loadConnectableWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.connect(
    ctx.id,
    ctx.principal === undefined ? undefined : auditActor(ctx.principal),
  );
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

export const POST = withObservability("workspaces.connect", handlePOST);
