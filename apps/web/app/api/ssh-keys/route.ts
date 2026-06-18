// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { registerSshKeyRequest } from "@edd/api-contracts";
import { SshKeyConflictError } from "@edd/control-plane";

import { authenticate, badRequest, conflict, isResponse } from "../../../lib/api";
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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const body = registerSshKeyRequest.safeParse(raw);
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
    // Unexpected — re-throw so withObservability logs it and returns a bodiless 500
    // (don't echo the internal error message to the client).
    throw err;
  }
}

export const GET = withObservability("sshKeys.list", handleGET);
export const POST = withObservability("sshKeys.register", handlePOST);
