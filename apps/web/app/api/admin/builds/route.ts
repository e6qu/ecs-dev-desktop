// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildTarget } from "@edd/api-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getImageOps } from "../../../../lib/image-ops";
import { withObservability } from "../../../../lib/observability";

/** Keep at most the last 20 builds in the history view. */
const BUILD_HISTORY_LIMIT = 20;

const triggerBody = z.object({
  target: buildTarget,
  tag: z.string().min(1).max(128),
  ref: z.string().min(1).max(256),
});

// GET /api/admin/builds — the project's last 20 builds (newest first).
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const builds = await getImageOps().listRecentBuilds(BUILD_HISTORY_LIMIT);
  return NextResponse.json({ builds });
}

// POST /api/admin/builds — trigger a build { target, tag, ref }. Returns the build id.
async function handlePOST(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const parsed = triggerBody.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid build request" }, { status: 400 });
  const buildId = await getImageOps().startBuild(parsed.data);
  return NextResponse.json({ buildId }, { status: 202 });
}

export const GET = withObservability("admin.builds.list", handleGET);
export const POST = withObservability("admin.builds.start", handlePOST);
