// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownedLifecycleAction } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";
import { workspaceLimit } from "../../../../../lib/quota";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/undelete — restore a terminated (deleted) workspace
// to `stopped` within the undelete-retention window; it wakes from its retained
// snapshot like any stopped workspace. Quota is re-admitted through the same
// atomic counter condition as create (the caller's role limit), so an undelete
// can't race an owner past their cap.
async function handlePOST(req: Request, { params }: Ctx) {
  return ownedLifecycleAction(req, params, (ctx) => {
    const limit = ctx.principal === undefined ? null : workspaceLimit(ctx.principal.role);
    return ctx.cp.undelete(ctx.id, {
      ...(limit === null ? {} : { quotaLimit: limit }),
      ...(ctx.principal === undefined ? {} : { actor: auditActor(ctx.principal) }),
    });
  });
}

export const POST = withObservability("workspaces.undelete", handlePOST);
