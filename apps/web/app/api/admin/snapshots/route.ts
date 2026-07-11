// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ListSnapshotsResponse } from "@edd/api-contracts";
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getControlPlane } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/snapshots — every managed EBS snapshot enriched with storage
// attribution + a `referenced` flag (a live/stopped workspace still restores from
// it). Admin only. The console highlights unreferenced retained orphans to purge.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const cp = await getControlPlane();
  const body: ListSnapshotsResponse = {
    snapshots: (await cp.listSnapshotsForAdmin()).map((s) => ({
      id: s.id,
      ...(s.workspaceId === undefined ? {} : { workspaceId: s.workspaceId }),
      ...(s.sizeGiB === undefined ? {} : { sizeGiB: s.sizeGiB }),
      createdAt: s.createdAt,
      retained: s.retained,
      referenced: s.referenced,
    })),
  };
  return NextResponse.json(body);
}

export const GET = withObservability("admin.snapshots.list", handleGET);
