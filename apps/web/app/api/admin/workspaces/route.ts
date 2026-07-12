// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getCatalogList, getControlPlane } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";
import { catalogByImage, enrichWorkspace } from "../../../../lib/workspace-enrich";

// GET /api/admin/workspaces — every workspace across all users (admin only).
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const cp = await getControlPlane();
  // Enrich identically to GET /api/workspaces (catalog image fields + sshCommand) so
  // the admin fleet view gets the same server-computed catalog join, not a bare list.
  const byImage = catalogByImage(await getCatalogList());
  const workspaces = (await cp.list()).map((ws) => enrichWorkspace(ws, byImage));
  return NextResponse.json({ workspaces });
}

export const GET = withObservability("admin.workspaces.list", handleGET);
