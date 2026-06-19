// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { logStream } from "@edd/api-contracts";
import { taskId as toTaskId, workspaceId, type LogReadFilter } from "@edd/core";

import { badRequest, isResponse, notFound, requireAdmin } from "../../../../lib/api";
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

  // Resolve an optional workspace filter to its task's log stream. It only applies to
  // the `container` stream (the control-plane/reconciler streams aren't per-workspace).
  let filter: LogReadFilter | undefined;
  const wsId = params.get("workspaceId");
  if (wsId !== null && wsId.length > 0 && parsed.data === "container") {
    const detail = await (await getControlPlane()).inspect(workspaceId(wsId));
    // An unknown id must NOT silently fall through to the unfiltered (all-container)
    // stream — that would leak every workspace's logs to a typo'd filter.
    if (detail == null) return notFound();
    const wsTaskId = detail.workspace.taskId;
    if (wsTaskId === undefined) {
      // The workspace exists but has no running task → no live container logs.
      return NextResponse.json({
        stream: parsed.data,
        available: true,
        note: "no running task for this workspace",
        lines: [],
      });
    }
    filter = { taskId: toTaskId(wsTaskId) };
  }

  return NextResponse.json(await getLogSource().read(parsed.data, filter));
}

export const GET = withObservability("admin.logs", handleGET);
