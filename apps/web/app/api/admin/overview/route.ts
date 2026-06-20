// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { withObservability } from "../../../../lib/observability";
import { getOverviewReport } from "../../../../lib/overview-report";

// GET /api/admin/overview — at-a-glance fleet + catalog counts (admin only). The
// Overview page renders this same report; an external client gets it too.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  return NextResponse.json(await getOverviewReport());
}

export const GET = withObservability("admin.overview", handleGET);
