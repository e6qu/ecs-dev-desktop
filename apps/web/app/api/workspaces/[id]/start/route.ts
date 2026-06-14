// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownedLifecycleAction } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/start — wake from snapshot (hydrate + run). The
// control plane records `session.start` on the wake transition (see
// workspaces/route.ts) — attributed to the caller, or `system` if machine-auth.
async function handlePOST(req: Request, { params }: Ctx) {
  return ownedLifecycleAction(req, params, (ctx) =>
    ctx.cp.start(ctx.id, ctx.principal === undefined ? undefined : auditActor(ctx.principal)),
  );
}

export const POST = withObservability("workspaces.start", handlePOST);
