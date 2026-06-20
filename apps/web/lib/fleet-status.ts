// SPDX-License-Identifier: AGPL-3.0-or-later
import { tallyWorkspaceStates, type WorkspaceStats } from "@edd/core";

import { getControlPlane } from "./control-plane";
import { ttlCache } from "./ttl-cache";

export interface FleetStatus {
  readonly stats: WorkspaceStats;
  /** Distinct workspace owners (active users). */
  readonly owners: number;
  /** Workspace count per owner, busiest first (feeds the admin quota report so it
   * shares this one cached scan instead of re-scanning the fleet itself). */
  readonly usage: readonly { readonly owner: string; readonly count: number }[];
}

/** TTL for the cached fleet aggregate. The admin Overview is at-a-glance and
 * tolerates mild staleness; at 200+ workspaces a full `list()` scan per page load —
 * and per concurrent admin / live refresh — is wasteful, so a short TTL collapses
 * bursts to a single scan. */
const FLEET_STATUS_TTL_MS = 10_000;

const cachedFleetStatus = ttlCache<FleetStatus>(async () => {
  const workspaces = await (await getControlPlane()).list();
  const perOwner = new Map<string, number>();
  for (const w of workspaces) perOwner.set(w.ownerId, (perOwner.get(w.ownerId) ?? 0) + 1);
  return {
    stats: tallyWorkspaceStates(workspaces.map((w) => w.state)),
    owners: perOwner.size,
    usage: [...perOwner.entries()]
      .map(([owner, count]) => ({ owner, count }))
      .sort((a, b) => b.count - a.count),
  };
}, FLEET_STATUS_TTL_MS);

/** The fleet aggregate (state tallies + distinct owners), cached for a short TTL so
 * the admin Overview doesn't re-scan the whole fleet on every load. */
export function getFleetStatus(nowMs: number = Date.now()): Promise<FleetStatus> {
  return cachedFleetStatus(nowMs);
}
