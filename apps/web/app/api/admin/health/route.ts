// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse } from "../../../../lib/api";
import { getHealthService } from "../../../../lib/control-plane";

// GET /api/admin/health — aggregate dependency health for the admin Health board.
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();
  const service = await getHealthService();
  return NextResponse.json(await service.report());
}
