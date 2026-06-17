// SPDX-License-Identifier: AGPL-3.0-or-later
import { COST_WINDOW_DAYS, costReportQuery } from "@edd/api-contracts";
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getCostService } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/costs — the fleet cost report (admin only): per session, rolled
// up per user and to a fleet total. Derived by pricing the first-class lifecycle
// audit ledger (running vs. scaled-to-zero time) at the configured rates.
// `?window=all|1d|7d|30d` (default all) scopes the report to the last N days.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  const { window } = costReportQuery.parse({
    window: new URL(req.url).searchParams.get("window") ?? undefined,
  });
  const report = await (await getCostService()).report(COST_WINDOW_DAYS[window]);
  return NextResponse.json(report);
}

export const GET = withObservability("admin.costs", handleGET);
