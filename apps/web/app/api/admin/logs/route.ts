// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { logStream } from "@edd/api-contracts";
import { taskId as toTaskId, workspaceId, type LogReadFilter } from "@edd/core";

import { badRequest, isResponse, requireAdmin } from "../../../../lib/api";
import { getControlPlane, getLogSource } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/logs?stream=control-plane|reconciler|container[&workspaceId=ws-…]
// — one log stream (admin only). The control-plane stream is derived now; the rest
// are reported explicitly unavailable until CloudWatch on AWS. An optional
// `workspaceId` narrows the `container` stream to that workspace's task logs.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  const params = new URL(req.url).searchParams;
  const parsed = logStream.safeParse(params.get("stream"));
  if (!parsed.success) return badRequest("unknown log stream");

  // Resolve an optional workspace filter to its task's log stream (container only).
  let filter: LogReadFilter | undefined;
  const wsId = params.get("workspaceId");
  if (wsId !== null && wsId.length > 0) {
    const detail = await (await getControlPlane()).inspect(workspaceId(wsId));
    const wsTaskId = detail?.workspace.taskId;
    if (wsTaskId !== undefined) filter = { taskId: toTaskId(wsTaskId) };
  }

  return NextResponse.json(await getLogSource().read(parsed.data, filter));
}

export const GET = withObservability("admin.logs", handleGET);
