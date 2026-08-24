// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { restoreWorkspaceRequest } from "@edd/api-contracts";
import { snapshotId } from "@edd/core";

import {
  badRequest,
  domainErrorResponse,
  isResponse,
  loadOwnedWorkspace,
} from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/restore — rewind a STOPPED workspace to one of its
// own snapshots; the next start hydrates that checkpoint. The service refuses a
// snapshot that does not exist or belongs to another workspace (one 404 for
// both, so snapshot ids are not an existence oracle), and refuses any state but
// `stopped`.
async function handlePOST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "update");
  if (isResponse(ctx)) return ctx;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = restoreWorkspaceRequest.safeParse(raw);
  if (!parsed.success) return badRequest();
  const actor = ctx.principal === undefined ? undefined : auditActor(ctx.principal);
  const result = await ctx.cp.restoreSnapshot(ctx.id, snapshotId(parsed.data.snapshotId), actor);
  return result.ok ? NextResponse.json(result.value) : domainErrorResponse(result.error);
}

export const POST = withObservability("workspaces.restore", handlePOST);
