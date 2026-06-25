// SPDX-License-Identifier: AGPL-3.0-or-later
import { tallyWorkspaceStates, type WorkspaceOwnerRole, type WorkspaceStats } from "@edd/core";

import { getControlPlane } from "./control-plane";
import { ttlCache } from "./ttl-cache";

export interface FleetStatus {
  readonly stats: WorkspaceStats;
  /** Distinct workspace owners (active users). */
  readonly owners: number;
  /** Workspace count per owner, busiest first (feeds the admin quota report so it
   * shares this one cached scan instead of re-scanning the fleet itself). `role` is the owner's
   * role, captured from any workspace they own that recorded it (absent for pre-`ownerRole` records). */
  readonly usage: readonly {
    readonly owner: string;
    readonly count: number;
    readonly role?: WorkspaceOwnerRole;
  }[];
}

/** TTL for the cached fleet aggregate. The admin Overview is at-a-glance and
 * tolerates mild staleness; at 200+ workspaces a full `list()` scan per page load —
 * and per concurrent admin / live refresh — is wasteful, so a short TTL collapses
 * bursts to a single scan. */
const FLEET_STATUS_TTL_MS = 10_000;

const cachedFleetStatus = ttlCache<FleetStatus>(async () => {
  const workspaces = await (await getControlPlane()).list();
  const perOwner = new Map<string, { count: number; role?: WorkspaceOwnerRole }>();
  for (const w of workspaces) {
    const cur = perOwner.get(w.ownerId) ?? { count: 0 };
    cur.count += 1;
    if (cur.role === undefined && w.ownerRole !== undefined) cur.role = w.ownerRole;
    perOwner.set(w.ownerId, cur);
  }
  return {
    stats: tallyWorkspaceStates(workspaces.map((w) => w.state)),
    owners: perOwner.size,
    usage: [...perOwner.entries()]
      .map(([owner, v]) => ({
        owner,
        count: v.count,
        ...(v.role === undefined ? {} : { role: v.role }),
      }))
      .sort((a, b) => b.count - a.count),
  };
}, FLEET_STATUS_TTL_MS);

/** The fleet aggregate (state tallies + distinct owners), cached for a short TTL so
 * the admin Overview doesn't re-scan the whole fleet on every load. */
export function getFleetStatus(nowMs: number = Date.now()): Promise<FleetStatus> {
  return cachedFleetStatus(nowMs);
}
