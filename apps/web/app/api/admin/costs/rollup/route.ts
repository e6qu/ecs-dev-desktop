// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse } from "../../../../../lib/api";
import { getCostService } from "../../../../../lib/control-plane";

// POST /api/admin/costs/rollup — regenerate the per-workspace cost checkpoints
// (admin only). Prices the whole ledger once and persists each workspace's
// accumulated billing state, so subsequent GET /api/admin/costs reports price only
// the tail since the checkpoint (O(recent), not O(history)) — same figures. Meant
// to be invoked periodically (a scheduled admin/cron call).
export async function POST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();

  await (await getCostService()).rollup();
  return NextResponse.json({ ok: true });
}
