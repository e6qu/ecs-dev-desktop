// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { DEFAULT_WORKSPACE_PORT } from "@edd/config";

import {
  badRequest,
  conflict,
  isResponse,
  loadConnectableWorkspace,
  notFound,
} from "../../../../../lib/api";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

const SSH_PORT = 22;

// GET /api/workspaces/:id/connect-info[?protocol=ssh|http] — returns the
// host:port for a running workspace's task ENI so a gateway proxy can forward to
// it. `protocol=ssh` (default) → sshd (the SSH gateway); `protocol=http` → the
// OpenVSCode HTTP port (the workspace gate fronting browser VS Code). The
// workspace must be running or idle; call POST /connect to wake it first. The
// host is the task ENI's private IPv4, routable within the VPC. Accepts the
// gateway's machine-auth token as well as a user session.
async function handleGET(req: Request, { params }: Ctx) {
  // Authenticate FIRST: an unauthenticated caller must get 401 regardless of the query,
  // never a pre-auth 400-vs-401 that distinguishes a valid from an invalid protocol.
  const ctx = await loadConnectableWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;

  const protocol = new URL(req.url).searchParams.get("protocol") ?? "ssh";
  if (protocol !== "ssh" && protocol !== "http") return badRequest("protocol must be ssh or http");

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

  const port = protocol === "http" ? DEFAULT_WORKSPACE_PORT : SSH_PORT;
  return NextResponse.json({ host: sshHost, port });
}

export const GET = withObservability("workspaces.connectInfo", handleGET);
