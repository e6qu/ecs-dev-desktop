// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";

// POST /api/workspaces/:id/stop — MANUAL stop: moves to the cancelable `stopping`
// state and converges the snapshot + scale-to-zero after a short grace (the idle
// auto-shutdown still uses the direct stop path). `session.stop` audited.
export const POST = lifecyclePOST("workspaces.stop", (ctx) =>
  ctx.cp.requestStop(ctx.id, ctx.principal === undefined ? undefined : auditActor(ctx.principal)),
);
