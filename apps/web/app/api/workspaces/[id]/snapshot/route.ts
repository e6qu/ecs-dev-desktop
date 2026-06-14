// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownedLifecycleAction } from "../../../../../lib/api";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/snapshot — point-in-time snapshot.
async function handlePOST(req: Request, { params }: Ctx) {
  return ownedLifecycleAction(req, params, (ctx) => ctx.cp.snapshot(ctx.id));
}

export const POST = withObservability("workspaces.snapshot", handlePOST);
