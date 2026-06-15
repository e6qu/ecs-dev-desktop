// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getInfrastructureService } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/infrastructure — cluster state, status checks, fleet metrics,
// and the component topology for the admin Infrastructure view.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const service = await getInfrastructureService();
  return NextResponse.json(await service.report());
}

export const GET = withObservability("admin.infrastructure", handleGET);
