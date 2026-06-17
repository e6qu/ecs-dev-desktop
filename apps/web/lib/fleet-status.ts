// SPDX-License-Identifier: AGPL-3.0-or-later
import { tallyWorkspaceStates, type WorkspaceStats } from "@edd/core";

import { getControlPlane } from "./control-plane";
import { ttlCache } from "./ttl-cache";

export interface FleetStatus {
  readonly stats: WorkspaceStats;
  /** Distinct workspace owners (active users). */
  readonly owners: number;
}

/** TTL for the cached fleet aggregate. The admin Overview is at-a-glance and
 * tolerates mild staleness; at 200+ workspaces a full `list()` scan per page load —
 * and per concurrent admin / live refresh — is wasteful, so a short TTL collapses
 * bursts to a single scan. */
const FLEET_STATUS_TTL_MS = 10_000;

const cachedFleetStatus = ttlCache<FleetStatus>(async () => {
  const workspaces = await (await getControlPlane()).list();
  return {
    stats: tallyWorkspaceStates(workspaces.map((w) => w.state)),
    owners: new Set(workspaces.map((w) => w.ownerId)).size,
  };
}, FLEET_STATUS_TTL_MS);

/** The fleet aggregate (state tallies + distinct owners), cached for a short TTL so
 * the admin Overview doesn't re-scan the whole fleet on every load. */
export function getFleetStatus(nowMs: number = Date.now()): Promise<FleetStatus> {
  return cachedFleetStatus(nowMs);
}
