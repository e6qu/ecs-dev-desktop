// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QuotaReportDto } from "@edd/api-contracts";

import { getControlPlane } from "./control-plane";
import { QUOTA_ROLES, workspaceLimit } from "./quota";

/**
 * The admin quota report — per-role workspace limits + current per-user usage. Built
 * once here and consumed by BOTH the `GET /api/admin/quotas` route (so a reskinned
 * frontend / external client gets it) and the server-rendered Quotas page, so neither
 * re-tallies the fleet or re-reads the env quota overrides inline.
 */
export async function getQuotaReport(): Promise<QuotaReportDto> {
  const workspaces = await (await getControlPlane()).list();
  const usage = new Map<string, number>();
  for (const w of workspaces) usage.set(w.ownerId, (usage.get(w.ownerId) ?? 0) + 1);
  return {
    limits: QUOTA_ROLES.map((role) => ({ role, limit: workspaceLimit(role) })),
    usage: [...usage.entries()]
      .map(([owner, count]) => ({ owner, count }))
      .sort((a, b) => b.count - a.count),
  };
}
