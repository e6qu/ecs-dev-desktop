// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse } from "../../../../lib/api";
import { getCostService } from "../../../../lib/control-plane";

// GET /api/admin/costs — the fleet cost report (admin only): per session, rolled
// up per user and to a fleet total. Derived by pricing the first-class lifecycle
// audit ledger (running vs. scaled-to-zero time) at the configured rates.
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();

  const report = await (await getCostService()).report();
  return NextResponse.json(report);
}
