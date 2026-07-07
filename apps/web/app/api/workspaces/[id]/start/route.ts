// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";

// POST /api/workspaces/:id/start — wake from snapshot (hydrate + run). The
// control plane records `session.start` on the wake transition — attributed to
// the caller, or `system` if machine-auth.
export const POST = lifecyclePOST("workspaces.start", (ctx) =>
  ctx.cp.start(ctx.id, ctx.principal === undefined ? undefined : auditActor(ctx.principal)),
);
