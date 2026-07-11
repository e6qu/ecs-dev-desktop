// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { checkReadiness } from "../../../lib/control-plane";
import { health } from "../../../lib/health";

// GET /api/system-status — the wake page's readiness poll. Unauthenticated by design:
// it reveals only whether the control plane is up and serving (the app process is
// running AND its DynamoDB table is reachable) plus the deployed SHA/time — nothing
// user-scoped. When the control plane has been scaled to zero, the request never
// reaches this handler (there is no task), so the poll simply keeps retrying until the
// wake path brings the service back and this returns `ready: true`; the wake page then
// reloads. Cheap: it reuses the same DynamoDB reachability check as /api/readyz.
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await checkReadiness();
  const ready = db.status === "ok";
  return NextResponse.json({ ready, deploy: health().deploy }, { status: ready ? 200 : 503 });
}
