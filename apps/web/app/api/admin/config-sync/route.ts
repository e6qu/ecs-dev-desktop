// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { isResponse, requireAdmin } from "../../../../lib/api";
import { getConfigSyncReport } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/config-sync — is the running deployment wired the way it should be?
// (real providers, ECS/EBS + observability coordinates present, DynamoDB + cluster
// reachable). The app-level self-check; deploy-time `terraform plan` drift is separate.
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  return NextResponse.json(await getConfigSyncReport());
}

export const GET = withObservability("admin.config_sync", handleGET);
