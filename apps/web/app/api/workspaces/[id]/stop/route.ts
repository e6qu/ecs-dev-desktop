// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";

// POST /api/workspaces/:id/stop — snapshot + scale to zero. `session.stop`
// recorded on the transition, attributed to the caller (or `system`).
export const POST = lifecyclePOST("workspaces.stop", (ctx) =>
  ctx.cp.stop(ctx.id, ctx.principal === undefined ? undefined : auditActor(ctx.principal)),
);
