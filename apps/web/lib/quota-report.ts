// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QuotaReportDto } from "@edd/api-contracts";

import { getFleetStatus } from "./fleet-status";
import { QUOTA_ROLES, workspaceLimit } from "./quota";

/**
 * The admin quota report — per-role workspace limits + current per-user usage. Built
 * once here and consumed by BOTH the `GET /api/admin/quotas` route (so a reskinned
 * frontend / external client gets it) and the server-rendered Quotas page. The per-owner
 * usage comes from the short-TTL cached fleet status (the SAME scan the admin Overview
 * uses), so the quota report doesn't re-scan the whole fleet on every load.
 */
export async function getQuotaReport(): Promise<QuotaReportDto> {
  const { usage } = await getFleetStatus();
  return {
    limits: QUOTA_ROLES.map((role) => ({ role, limit: workspaceLimit(role) })),
    usage: [...usage],
  };
}
