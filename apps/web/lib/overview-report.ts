// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OverviewReportDto, WorkspaceStateDto } from "@edd/api-contracts";

import { getCatalog } from "./control-plane";
import { getFleetStatus } from "./fleet-status";

/**
 * The admin Overview report — at-a-glance fleet + catalog counts. Built once here and
 * served by both `GET /api/admin/overview` and the Overview page, so neither aggregates
 * the fleet or filters the by-state breakdown inline. The fleet aggregate itself is
 * short-TTL cached (see `getFleetStatus`) so this is cheap at 200+ workspaces.
 */
export async function getOverviewReport(): Promise<OverviewReportDto> {
  const [{ stats, owners }, catalog] = await Promise.all([getFleetStatus(), getCatalog().list()]);
  return {
    workspaces: { total: stats.total, active: stats.active, stopped: stats.byState.stopped },
    activeUsers: owners,
    baseImages: { total: catalog.length, enabled: catalog.filter((c) => c.enabled).length },
    // Non-zero states only; the keys of `byState` are the lifecycle states (== the DTO enum).
    byState: (Object.entries(stats.byState) as [WorkspaceStateDto, number][])
      .filter(([, count]) => count > 0)
      .map(([state, count]) => ({ state, count })),
  };
}
