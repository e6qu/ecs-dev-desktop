// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getImageOps } from "../../../../lib/image-ops";
import { withObservability } from "../../../../lib/observability";

/** Keep at most the last 20 builds in the history view. */
const BUILD_HISTORY_LIMIT = 20;

// GET /api/admin/builds — the project's last 20 builds (newest first).
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const builds = await getImageOps().listRecentBuilds(BUILD_HISTORY_LIMIT);
  return NextResponse.json({ builds });
}

// POST /api/admin/builds — image builds are launched by GitHub Actions workflows.
async function handlePOST(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  return NextResponse.json(
    { error: "image builds are launched by GitHub Actions workflows" },
    { status: 410 },
  );
}

export const GET = withObservability("admin.builds.list", handleGET);
export const POST = withObservability("admin.builds.start", handlePOST);
