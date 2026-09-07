// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import type { WorkspaceDto } from "@edd/api-contracts";
import { workspaceId } from "@edd/core";

import { notFound } from "./api";
import { getControlPlane } from "./control-plane";
import { checkAgentAuth } from "./machine-auth";

/**
 * The gate every secret-emitting workspace broker route shares (git credential, git SSH
 * keys): the caller must be the workspace's own idle-agent (HMAC machine-auth — there is
 * NO session fallback, so only the workspace itself can fetch its secrets and they never
 * reach the browser or task metadata), the workspace must exist, and it must not be on
 * its way out. `get` returns the `deleting` tombstone (and a `terminated` record) too, so
 * without the lifecycle check a lingering container whose deletion is in flight could keep
 * pulling secrets; every other lifecycle decision refuses to act on a tombstone, and these
 * routes must too.
 */
export async function loadBrokeredWorkspace(
  req: Request,
  id: string,
): Promise<WorkspaceDto | NextResponse> {
  if (checkAgentAuth(req, id) !== "valid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ws = await (await getControlPlane()).get(workspaceId(id));
  if (!ws) return notFound();
  if (ws.state === "deleting" || ws.state === "terminated") return notFound();
  return ws;
}
