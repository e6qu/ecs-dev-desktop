// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getControlPlane } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/workspaces — every workspace across all users (admin only).
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const cp = await getControlPlane();
  return NextResponse.json({ workspaces: await cp.list() });
}

export const GET = withObservability("admin.workspaces.list", handleGET);
