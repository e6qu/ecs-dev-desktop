// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { sshAuthorizeRequest } from "@edd/api-contracts";
import { sshPublicKey, workspaceId, workspacePrincipal } from "@edd/core";

import { badRequest, notFound } from "../../../../../lib/api";
import { getControlPlane, getSshKeyService } from "../../../../../lib/control-plane";
import { checkAgentAuth, checkGatewayAuth } from "../../../../../lib/machine-auth";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

// POST /api/workspaces/:id/ssh-authorize — the connect-time decision for the
// dual-trust SSH path. Machine-auth only (per-workspace HMAC; no session): the
// **gateway** token (its sshd's AuthorizedKeysCommand on the public hop) OR the
// **workspace agent** token (the workspace sshd's AuthorizedKeysCommand on the
// inner hop) — both ends authorize the same presented key against the same
// decision. Given the public key the connecting client offered, authorize iff the
// key is registered AND its owner owns this workspace. Works on a stopped
// workspace — the ownership record persists across scale-to-zero.
async function handlePOST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const authed = checkGatewayAuth(req, id) === "valid" || checkAgentAuth(req, id) === "valid";
  if (!authed) return unauthorized();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const body = sshAuthorizeRequest.safeParse(raw);
  if (!body.success) return badRequest(body.error.issues[0]?.message);

  const ws = await (await getControlPlane()).get(workspaceId(id));
  if (!ws) return notFound();

  const match = await getSshKeyService().ownerForKey(sshPublicKey(body.data.publicKey));
  const authorized = match !== null && match.ownerId === ws.ownerId;
  return NextResponse.json(
    authorized ? { authorized: true, principal: workspacePrincipal(id) } : { authorized: false },
  );
}

export const POST = withObservability("workspaces.sshAuthorize", handlePOST);
