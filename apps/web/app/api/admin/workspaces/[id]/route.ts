// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import { NextResponse } from "next/server";

import { isResponse, notFound, requireAdmin } from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/admin/workspaces/:id — full detail + derived lifecycle timeline (admin only).
async function handleGET(req: Request, { params }: Ctx) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const cp = await getControlPlane();
  const inspection = await cp.inspect(workspaceId((await params).id));
  return inspection === null ? notFound() : NextResponse.json(inspection);
}

export const GET = withObservability("admin.workspaces.get", handleGET);
