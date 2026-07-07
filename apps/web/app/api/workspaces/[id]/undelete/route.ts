// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { workspaceLimit } from "../../../../../lib/quota";

// POST /api/workspaces/:id/undelete — restore a terminated (deleted) workspace
// to `stopped` within the undelete-retention window; it wakes from its retained
// snapshot like any stopped workspace. Quota is re-admitted through the same
// atomic counter condition as create (the caller's role limit).
export const POST = lifecyclePOST("workspaces.undelete", (ctx) => {
  const limit = ctx.principal === undefined ? null : workspaceLimit(ctx.principal.role);
  return ctx.cp.undelete(ctx.id, {
    ...(limit === null ? {} : { quotaLimit: limit }),
    ...(ctx.principal === undefined ? {} : { actor: auditActor(ctx.principal) }),
  });
});
