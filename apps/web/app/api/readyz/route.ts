// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { checkReadiness } from "../../../lib/control-plane";

// GET /api/readyz — readiness probe for the ALB target group. Unlike /api/healthz
// (liveness: the process is up), readiness fails when the control plane cannot
// reach its data store, so the load balancer stops routing to a task that can't
// serve — without the ECS container being restarted. 200 when DynamoDB is ACTIVE,
// 503 otherwise.
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await checkReadiness();
  const ready = db.status === "ok";
  return NextResponse.json(
    { status: ready ? "ready" : "unready", checks: [db] },
    { status: ready ? 200 : 503 },
  );
}
