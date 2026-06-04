// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse } from "../../../../lib/api";
import { getControlPlane } from "../../../../lib/control-plane";

// GET /api/admin/workspaces — every workspace across all users (admin only).
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();
  const cp = await getControlPlane();
  return NextResponse.json({ workspaces: await cp.list() });
}
