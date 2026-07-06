// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import type { WorkspaceLogsDto } from "@edd/api-contracts";
import { taskId as toTaskId } from "@edd/core";

import { isResponse, loadOwnedWorkspaceDetail } from "../../../../../lib/api";
import { getLogSource } from "../../../../../lib/control-plane";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/workspaces/:id/logs — the owner-facing slice of this workspace's
// container log stream (boot + runtime), for the workspace status page. Same
// CloudWatch source the admin Logs screen uses, narrowed to the workspace's own
// ECS task and gated on ownership (owner or admin), so a member can watch their
// OWN session boot without the admin console.
async function handleGET(req: Request, { params }: Ctx) {
  const loaded = await loadOwnedWorkspaceDetail(req, params);
  if (isResponse(loaded)) return loaded;
  // The task id lives on the full detail record (the list DTO omits it).
  const wsTaskId = loaded.detail.workspace.taskId;
  if (wsTaskId === undefined) {
    const body: WorkspaceLogsDto = {
      available: false,
      note: "no running task — logs appear once the workspace task starts",
      lines: [],
    };
    return NextResponse.json(body);
  }

  const result = await getLogSource().read("container", { taskId: toTaskId(wsTaskId) });
  const body: WorkspaceLogsDto = {
    available: result.available,
    note: result.note,
    lines: result.lines.map((l) => ({
      at: l.at,
      level: l.level,
      source: l.source,
      message: l.message,
    })),
  };
  return NextResponse.json(body);
}

export const GET = withObservability("workspaces.logs", handleGET);
