// SPDX-License-Identifier: AGPL-3.0-or-later
import { trafficFilterPolicy, trafficFilterState } from "@edd/api-contracts";
import { WafApplyError } from "@edd/control-plane";
import { NextResponse } from "next/server";

import { badRequest, isResponse, requireAdmin } from "../../../../lib/api";
import { getTrafficFilterService } from "../../../../lib/control-plane";
import { withObservability } from "../../../../lib/observability";

// GET /api/admin/traffic — the current traffic-filter policy, its compiled WAF rule
// preview + default action, the available cloud/hoster presets, and the last apply
// outcome. Admin only. Works without WAF coordinates configured (no apply here).
async function handleGET(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;
  const state = await getTrafficFilterService().getState();
  return NextResponse.json(trafficFilterState.parse(state));
}

// PUT /api/admin/traffic — replace the policy and apply it to the live WAFv2 Web ACL.
// An invalid policy is a 400 (compile throws before any write); a WAF apply failure is
// a 500 with the underlying reason (the policy IS persisted with the recorded error).
async function handlePUT(req: Request) {
  const principal = await requireAdmin(req);
  if (isResponse(principal)) return principal;

  const parsed = trafficFilterPolicy.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid traffic-filter policy");

  const svc = getTrafficFilterService();
  try {
    const state = await svc.updatePolicy(parsed.data, principal.id);
    return NextResponse.json(trafficFilterState.parse(state));
  } catch (e) {
    // The pure core throws on an invalid policy (semantic validation beyond the Zod
    // shape); surface that as a 400.
    if (e instanceof Error && e.message.startsWith("invalid traffic-filter policy")) {
      return badRequest(e.message);
    }
    // A live-WAF apply failure is a 5xx — the policy is persisted, only the apply
    // failed (and the error is recorded on the state for a subsequent GET).
    if (e instanceof WafApplyError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    throw e;
  }
}

export const GET = withObservability("admin.traffic.get", handleGET);
export const PUT = withObservability("admin.traffic.update", handlePUT);
