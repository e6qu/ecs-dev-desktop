// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PurgeUnreferencedSnapshotsResponse } from "@edd/api-contracts";
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { getControlPlane } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

// POST /api/admin/snapshots/purge-unreferenced — bulk-reap every managed snapshot
// no live/stopped workspace restores from (the accumulated retained orphans). Admin
// only; referenced snapshots are skipped. Returns the ids actually purged.
async function handlePOST(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const cp = await getControlPlane();
  const { purged } = await cp.purgeUnreferencedSnapshots(auditActor(principal));
  const body: PurgeUnreferencedSnapshotsResponse = {
    purged: purged.length,
    snapshotIds: [...purged],
  };
  return NextResponse.json(body);
}

export const POST = withObservability("admin.snapshots.purge_unreferenced", handlePOST);
