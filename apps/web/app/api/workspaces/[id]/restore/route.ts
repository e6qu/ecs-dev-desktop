// SPDX-License-Identifier: AGPL-3.0-or-later
import { restoreWorkspaceRequest } from "@edd/api-contracts";
import { snapshotId } from "@edd/core";

import { lifecyclePOSTWithBody } from "../../../../../lib/api";
import { auditActor } from "../../../../../lib/audit";

// POST /api/workspaces/:id/restore — rewind a STOPPED workspace to one of its
// own snapshots; the next start hydrates that checkpoint. The service refuses a
// snapshot that does not exist or belongs to another workspace (one 404 for
// both, so snapshot ids are not an existence oracle), and refuses any state but
// `stopped`.
export const POST = lifecyclePOSTWithBody(
  "workspaces.restore",
  restoreWorkspaceRequest,
  (ctx, body) =>
    ctx.cp.restoreSnapshot(
      ctx.id,
      snapshotId(body.snapshotId),
      ctx.principal === undefined ? undefined : auditActor(ctx.principal),
    ),
);
