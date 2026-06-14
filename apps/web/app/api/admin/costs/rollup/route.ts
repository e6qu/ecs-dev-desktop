// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../../lib/api";
import { getCostService } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

// POST /api/admin/costs/rollup — regenerate the per-workspace cost checkpoints
// (admin only). Prices the whole ledger once and persists each workspace's
// accumulated billing state, so subsequent GET /api/admin/costs reports price only
// the tail since the checkpoint (O(recent), not O(history)) — same figures. Meant
// to be invoked periodically (a scheduled admin/cron call).
async function handlePOST(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  await (await getCostService()).rollup();
  return NextResponse.json({ ok: true });
}

export const POST = withObservability("admin.costs.rollup", handlePOST);
