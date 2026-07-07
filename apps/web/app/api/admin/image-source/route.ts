// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getImageSourceService } from "../../../../lib/image-source";
import { withObservability } from "../../../../lib/observability";

async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const service = getImageSourceService();
  await service.reconcileRecentBuilds();
  return NextResponse.json(await service.state());
}

export const GET = withObservability("admin.image-source", handleGET);
