// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { withObservability } from "../../../../lib/observability";
import { getQuotaReport } from "../../../../lib/quota-report";

// GET /api/admin/quotas — per-role workspace limits + current per-user usage (admin
// only). The Quotas page renders this same report; an external client gets it too.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  return NextResponse.json(await getQuotaReport());
}

export const GET = withObservability("admin.quotas", handleGET);
