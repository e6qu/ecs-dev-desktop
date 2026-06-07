// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";
import { sshCertRequest } from "@edd/api-contracts";
import { workspacePrincipal } from "@edd/core";

import { badRequest, isResponse, loadOwnedWorkspace } from "../../../../../lib/api";
import { caKeyPath, signCert } from "../../../../../lib/ssh-cert";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/workspaces/:id/ssh-cert — sign the caller's public key with the workspace
// SSH CA and return a short-lived certificate granting the workspace principal.
// The cert TTL is 1 hour; the caller writes it alongside their private key
// (<key>-cert.pub) and the SSH client picks it up automatically.
export async function POST(req: Request, { params }: Ctx) {
  const ctx = await loadOwnedWorkspace(req, params, "read");
  if (isResponse(ctx)) return ctx;

  const body = sshCertRequest.safeParse(await req.json());
  if (!body.success) return badRequest(body.error.issues[0]?.message);

  const principal = workspacePrincipal(ctx.id);
  const identity = `${ctx.ws.ownerId}/${ctx.id}`;

  let cert: string;
  try {
    cert = signCert(caKeyPath(), body.data.publicKey, principal, identity);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ cert });
}
