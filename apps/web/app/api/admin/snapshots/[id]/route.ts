// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PurgeSnapshotResponse } from "@edd/api-contracts";
import { snapshotId } from "@edd/core";
import { NextResponse } from "next/server";

import { domainErrorResponse, isResponse, requireAdmin } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { getControlPlane } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// DELETE /api/admin/snapshots/:id — permanently reap one EBS snapshot (admin only).
// Refused with 409 when a live/stopped workspace still restores from it (purging it
// would strand that workspace); an already-gone snapshot is an idempotent success.
async function handleDELETE(req: Request, { params }: Ctx) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const cp = await getControlPlane();
  const id = snapshotId((await params).id);
  const result = await cp.deleteSnapshotById(id, auditActor(principal));
  if (!result.ok) return domainErrorResponse(result.error);
  const body: PurgeSnapshotResponse = { id, purged: true };
  return NextResponse.json(body);
}

export const DELETE = withObservability("admin.snapshots.purge", handleDELETE);
