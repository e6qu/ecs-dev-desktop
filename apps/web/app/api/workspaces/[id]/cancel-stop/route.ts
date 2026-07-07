// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";

// POST /api/workspaces/:id/cancel-stop — cancel an in-flight manual stop and
// resume the still-running session (idempotent). Only meaningful while `stopping`.
export const POST = lifecyclePOST("workspaces.cancelStop", (ctx) =>
  ctx.cp.cancelStop(ctx.id, ctx.principal === undefined ? undefined : auditActor(ctx.principal)),
);
