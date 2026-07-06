// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../../lib/api";
import { getImageOps } from "../../../../../lib/image-ops";
import { withObservability } from "../../../../../lib/observability";

// GET /api/admin/builds/logs?buildId=&token= — a slice of a build's live log +
// the cursor to poll the next slice, plus the build's current status/phase.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  const url = new URL(req.url);
  const buildId = url.searchParams.get("buildId");
  if (buildId === null) return NextResponse.json({ error: "buildId required" }, { status: 400 });
  const token = url.searchParams.get("token") ?? undefined;

  const ops = getImageOps();
  const observation = await ops.getBuild(buildId);
  if (observation === null) return NextResponse.json({ error: "build not found" }, { status: 404 });
  const chunk = await ops.getBuildLogs(observation, token);
  return NextResponse.json({
    status: observation.status,
    ...(observation.phase === undefined ? {} : { phase: observation.phase }),
    ...chunk,
  });
}

export const GET = withObservability("admin.builds.logs", handleGET);
