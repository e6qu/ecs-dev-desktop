// SPDX-License-Identifier: AGPL-3.0-or-later
import { lifecyclePOST } from "../../../../../lib/api";

// POST /api/workspaces/:id/retry — user-initiated retry of a failed launch (the
// status page's Retry button on an `error` workspace). A snapshot-less error
// relaunches fresh compute; one with a surviving snapshot recovers to stopped
// and starts, so its data is never discarded.
export const POST = lifecyclePOST("workspaces.retry", (ctx) => ctx.cp.retry(ctx.id));
