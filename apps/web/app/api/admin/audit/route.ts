// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_AUDIT_FEED_LIMIT } from "@edd/core";
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse } from "../../../../lib/api";
import { getAuditLog, getAuditSource } from "../../../../lib/control-plane";

// GET /api/admin/audit — the audit feed, newest first (admin only). Merges the
// first-class actor-attributed action log (who did what — `session.*`/`repo.*`)
// with the derived fleet lifecycle feed (`workspace.*`, inferred from state;
// CloudTrail-backed on AWS).
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();

  const [stored, derived] = await Promise.all([getAuditLog().recent(), getAuditSource().recent()]);
  const events = [...stored, ...derived]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, DEFAULT_AUDIT_FEED_LIMIT);
  return NextResponse.json({ events });
}
