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
  const limits = QUOTA_ROLES.map((role) => ({ role, limit: workspaceLimit(role) }));
  // Strictest POSITIVE finite cap across roles — the smallest cap that actually permits a workspace
  // (a 0 cap, e.g. viewer, is excluded: it would trivially flag every owner-of-any-workspace). For a
  // row whose owner role is unknown (records predating `ownerRole`), count >= this means they're
  // over the smallest meaningful cap, so the flag is a safe lower bound, not a false positive.
  const positiveFinite = limits.map((l) => l.limit).filter((l): l is number => l !== null && l > 0);
  const strictest = positiveFinite.length > 0 ? Math.min(...positiveFinite) : null;

  return {
    limits,
    usage: usage.map((u) => {
      const ownLimit = u.role !== undefined ? workspaceLimit(u.role) : null;
      // Known role → flag against the owner's own cap (null = unlimited ⇒ never flagged); unknown
      // role → flag against the strictest positive cap as a safe lower bound.
      const flagAgainst = u.role !== undefined ? ownLimit : strictest;
      return {
        owner: u.owner,
        count: u.count,
        ...(u.role === undefined ? {} : { role: u.role }),
        limit: ownLimit,
        atOrOver: flagAgainst !== null && u.count >= flagAgainst,
      };
    }),
  };
}
