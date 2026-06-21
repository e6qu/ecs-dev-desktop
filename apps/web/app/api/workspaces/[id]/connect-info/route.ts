// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { sshConnectInfo } from "@edd/api-contracts";

import { conflict, isResponse, loadConnectableWorkspace, notFound } from "../../../../../lib/api";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

const SSH_PORT = 22;

// GET /api/workspaces/:id/connect-info — returns the host:port for a running
// workspace's task ENI so the SSH gateway can forward to its sshd. The workspace
// must be running or idle; call POST /connect to wake it first. The host is the
// task ENI's private IPv4, routable within the VPC. Accepts the gateway's
// machine-auth token as well as a user session. (Browser VS Code is served by the
// control-plane app's own in-app proxy, which resolves the editor upstream in
// process — it does not use this endpoint.)
async function handleGET(req: Request, { params }: Ctx) {
  const ctx = await loadConnectableWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;

  if (ctx.ws.state !== "running" && ctx.ws.state !== "idle") {
    return conflict(`workspace ${ctx.id} is ${ctx.ws.state} — call POST /connect to wake it first`);
  }

  // Load the full detail to get sshHost (WorkspaceDto omits runtime bindings).
  const detail = await ctx.cp.inspect(ctx.id);
  if (!detail) return notFound();

  const { sshHost } = detail.workspace;
  // The workspace exists and is running, but the task ENI's private IP isn't bound yet
  // (a transient window right after wake) — a retry-able 409, NOT a 404 (which reads as
  // "wrong id" to a polling gateway).
  if (!sshHost) {
    return conflict(`workspace ${ctx.id} host not yet assigned — retry shortly`);
  }

  // Validate the body against the contract before emitting it (every JSON route either
  // parses its output or returns a service-built DTO — this hand-built body must too, so
  // the `host: min(1)` / `port` invariants hold at the wire boundary, not just client-side).
  return NextResponse.json(sshConnectInfo.parse({ host: sshHost, port: SSH_PORT }));
}

export const GET = withObservability("workspaces.connectInfo", handleGET);
