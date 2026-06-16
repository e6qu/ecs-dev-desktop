// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { registerSshKeyRequest } from "@edd/api-contracts";
import { SshKeyConflictError } from "@edd/control-plane";

import { authenticate, badRequest, conflict, errorMessage, isResponse } from "../../../lib/api";
import { getSshKeyService } from "../../../lib/control-plane";
import { withObservability } from "../../../lib/observability";

// GET /api/ssh-keys — the caller's registered SSH public keys.
async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  const keys = await getSshKeyService().list(principal.id);
  return NextResponse.json({ keys });
}

// POST /api/ssh-keys — register an account-level SSH public key for the caller.
// 409 if the key is already registered (to this account or another).
async function handlePOST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const body = registerSshKeyRequest.safeParse(await req.json());
  if (!body.success) return badRequest(body.error.issues[0]?.message);

  try {
    const key = await getSshKeyService().register(
      principal.id,
      body.data.publicKey,
      body.data.label,
    );
    return NextResponse.json({ key }, { status: 201 });
  } catch (err) {
    if (err instanceof SshKeyConflictError) return conflict(err.message);
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}

export const GET = withObservability("sshKeys.list", handleGET);
export const POST = withObservability("sshKeys.register", handlePOST);
