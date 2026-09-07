// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { generateGitSshKeyRequest } from "@edd/api-contracts";

import { authenticate, badRequest, conflict, isResponse } from "../../../lib/api";
import { gitIntegration } from "../../../lib/git-integration";
import { getGitSshKeys } from "../../../lib/git-credentials";
import { withObservability } from "../../../lib/observability";

const NOT_CONFIGURED =
  "git SSH keys are not enabled on this deployment (EDD_TOKEN_ENC_KEY is unset)";

// GET /api/git-ssh-keys — the caller's platform-generated git SSH keys (public halves).
async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!gitIntegration().sshKeys) return conflict(NOT_CONFIGURED);
  const keys = await getGitSshKeys().list(principal.id);
  return NextResponse.json({ keys });
}

// POST /api/git-ssh-keys — generate a new named key for the caller. The private half is
// stored encrypted and only ever delivered into the caller's workspaces.
async function handlePOST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  if (!gitIntegration().sshKeys) return conflict(NOT_CONFIGURED);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const body = generateGitSshKeyRequest.safeParse(raw);
  if (!body.success) return badRequest(body.error.issues[0]?.message);

  const key = await getGitSshKeys().generate(principal.id, body.data.label);
  return NextResponse.json({ key }, { status: 201 });
}

export const GET = withObservability("gitSshKeys.list", handleGET);
export const POST = withObservability("gitSshKeys.generate", handlePOST);
