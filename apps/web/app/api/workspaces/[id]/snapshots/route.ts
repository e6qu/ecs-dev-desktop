// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import {
  domainErrorResponse,
  isResponse,
  loadOwnedWorkspace,
  type IdRouteContext,
} from "../../../../../lib/api";
import { withObservability } from "../../../../../lib/observability";

// GET /api/workspaces/:id/snapshots — the workspace's own checkpoint history,
// newest first, with the current restore point marked.
async function handleGET(req: Request, { params }: IdRouteContext) {
  const ctx = await loadOwnedWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;
  const result = await ctx.cp.listWorkspaceSnapshots(ctx.id);
  if (!result.ok) return domainErrorResponse(result.error);
  return NextResponse.json({ snapshots: result.value });
}

export const GET = withObservability("workspaces.snapshots", handleGET);
