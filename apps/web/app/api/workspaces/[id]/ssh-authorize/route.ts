// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { sshAuthorizeRequest } from "@edd/api-contracts";
import { workspaceId, workspacePrincipal } from "@edd/core";

import { badRequest, notFound } from "../../../../../lib/api";
import { getControlPlane, getSshKeyService } from "../../../../../lib/control-plane";
import { checkGatewayAuth } from "../../../../../lib/machine-auth";
import { withObservability } from "../../../../../lib/observability";

interface Ctx {
  params: Promise<{ id: string }>;
}

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

// POST /api/workspaces/:id/ssh-authorize — the SSH gateway's connect-time
// decision. Gateway machine-auth ONLY (per-workspace HMAC; no session). Given the
// public key the connecting client offered, authorize the connection iff the key
// is registered AND its owner owns this workspace. The authentication (key →
// user) and authorization (user → this workspace) both resolve here so the
// gateway's AuthorizedKeysCommand stays a thin curl. Works on a stopped
// workspace — the ownership record persists across scale-to-zero.
async function handlePOST(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (checkGatewayAuth(req, id) !== "valid") return unauthorized();

  const body = sshAuthorizeRequest.safeParse(await req.json());
  if (!body.success) return badRequest(body.error.issues[0]?.message);

  const ws = await (await getControlPlane()).get(workspaceId(id));
  if (!ws) return notFound();

  const match = await getSshKeyService().ownerForKey(body.data.publicKey);
  const authorized = match !== null && match.ownerId === ws.ownerId;
  return NextResponse.json(
    authorized ? { authorized: true, principal: workspacePrincipal(id) } : { authorized: false },
  );
}

export const POST = withObservability("workspaces.sshAuthorize", handlePOST);
