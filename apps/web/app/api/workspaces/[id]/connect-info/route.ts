// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { conflict, isResponse, loadOwnedWorkspace, notFound } from "../../../../../lib/api";

interface Ctx {
  params: Promise<{ id: string }>;
}

const SSH_PORT = 22;

// GET /api/workspaces/:id/connect-info — returns the SSH host:port for a running
// workspace's task ENI, so the gateway proxy can forward the TCP connection.
// The workspace must be running or idle; call POST /connect to wake it first.
// The host is the private IPv4 address of the Fargate task's ENI, routable within
// the VPC.
export async function GET(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;

  if (ctx.ws.state !== "running" && ctx.ws.state !== "idle") {
    return conflict(`workspace ${ctx.id} is ${ctx.ws.state} — call POST /connect to wake it first`);
  }

  // Load the full detail to get sshHost (WorkspaceDto omits runtime bindings).
  const detail = await ctx.cp.inspect(ctx.id);
  if (!detail) return notFound();

  const { sshHost } = detail.workspace;
  if (!sshHost) return notFound();

  return NextResponse.json({ host: sshHost, port: SSH_PORT });
}
