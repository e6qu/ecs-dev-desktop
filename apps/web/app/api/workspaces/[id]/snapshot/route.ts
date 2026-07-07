// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";

// POST /api/workspaces/:id/snapshot — point-in-time snapshot of the live volume.
export const POST = lifecyclePOST("workspaces.snapshot", (ctx) => ctx.cp.snapshot(ctx.id));
