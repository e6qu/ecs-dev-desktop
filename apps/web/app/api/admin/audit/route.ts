// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_AUDIT_FEED_LIMIT, type AuditEvent } from "@edd/core";
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getAuditLog, getAuditSource } from "../../../../lib/control-plane";
import { errorField, log } from "../../../../lib/logger";
import { withObservability } from "../../../../lib/observability";

/** One source's events, or [] if that source errors — so a single failing source
 * degrades the feed rather than blanking it. The failure is logged (not silent). */
async function safeRecent(
  label: string,
  source: { recent: () => Promise<AuditEvent[]> },
): Promise<AuditEvent[]> {
  try {
    return await source.recent();
  } catch (err) {
    log.error("audit source failed", { source: label, error: errorField(err) });
    return [];
  }
}

// GET /api/admin/audit — the audit feed, newest first (admin only). Merges the
// first-class actor-attributed action log (who did what — `session.*`/`repo.*`)
// with the derived fleet lifecycle feed (`workspace.*`, inferred from state;
// CloudTrail-backed on AWS).
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  const [stored, derived] = await Promise.all([
    safeRecent("stored", getAuditLog()),
    safeRecent("derived", getAuditSource()),
  ]);
  const events = [...stored, ...derived]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, DEFAULT_AUDIT_FEED_LIMIT);
  return NextResponse.json({ events });
}

export const GET = withObservability("admin.audit", handleGET);
