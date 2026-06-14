// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownedLifecycleAction } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/stop — scale to zero (snapshot + tear down). The
// control plane records `session.stop` on the transition (see
// workspaces/route.ts) — attributed to the caller, or `system` if machine-auth.
async function handlePOST(req: Request, { params }: Ctx) {
  return ownedLifecycleAction(req, params, (ctx) =>
    ctx.cp.stop(ctx.id, ctx.principal === undefined ? undefined : auditActor(ctx.principal)),
  );
}

export const POST = withObservability("workspaces.stop", handlePOST);
