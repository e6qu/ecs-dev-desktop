// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse } from "../../../../lib/api";
import { getAuditSource } from "../../../../lib/control-plane";

// GET /api/admin/audit — derived fleet audit feed, newest first (admin only).
// CloudTrail-backed on AWS (`docs/admin-ui-design.md`).
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();
  return NextResponse.json({ events: await getAuditSource().recent() });
}
