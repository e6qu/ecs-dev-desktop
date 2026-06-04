// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { logStream } from "@edd/api-contracts";

import { authenticate, badRequest, forbidden, isResponse } from "../../../../lib/api";
import { getLogSource } from "../../../../lib/control-plane";

// GET /api/admin/logs?stream=control-plane|reconciler|container — one log stream
// (admin only). The control-plane stream is derived now; the rest are reported
// explicitly unavailable until CloudWatch on AWS (`docs/admin-ui-design.md`).
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();

  const parsed = logStream.safeParse(new URL(req.url).searchParams.get("stream"));
  if (!parsed.success) return badRequest("unknown log stream");
  return NextResponse.json(await getLogSource().read(parsed.data));
}
