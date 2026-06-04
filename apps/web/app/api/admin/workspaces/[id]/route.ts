// SPDX-License-Identifier: AGPL-3.0-or-later
import { workspaceId } from "@edd/core";
import { NextResponse } from "next/server";

import { authenticate, forbidden, isResponse, notFound } from "../../../../../lib/api";
import { getControlPlane } from "../../../../../lib/control-plane";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/admin/workspaces/:id — full detail + derived lifecycle timeline (admin only).
export async function GET(req: Request, { params }: Ctx) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (principal.role !== "admin") return forbidden();
  const cp = await getControlPlane();
  const inspection = await cp.inspect(workspaceId((await params).id));
  return inspection === null ? notFound() : NextResponse.json(inspection);
}
