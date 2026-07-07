// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerId } from "@edd/core";
import { NextResponse } from "next/server";

import { authenticate, badRequest, conflict, isResponse } from "../../../../../lib/api";
import { auditActor, recordAudit } from "../../../../../lib/audit";
import {
  exchangeGithubConnectCode,
  githubOAuthConfigFromEnv,
  verifyGithubConnectState,
} from "../../../../../lib/github-connect";
import { getGitCredentials } from "../../../../../lib/git-credentials";
import { withObservability } from "../../../../../lib/observability";

async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  if (code === null || code.length === 0 || state === null || state.length === 0) {
    return badRequest("missing GitHub OAuth callback parameters");
  }

  let parsed;
  try {
    parsed = verifyGithubConnectState(state, new Date());
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "invalid GitHub connect state");
  }
  if (parsed.ownerId !== principal.id) {
    return conflict("GitHub connect state belongs to a different signed-in user");
  }

  const redirectUri = new URL("/api/github/connect/callback", requestUrl.origin).toString();
  const token = await exchangeGithubConnectCode(githubOAuthConfigFromEnv(), code, redirectUri);
  await getGitCredentials().store(ownerId(principal.id), token.accessToken);
  await recordAudit({
    actor: auditActor(principal),
    action: "github.connect",
    target: principal.id,
    detail: `linked GitHub OAuth token with scopes: ${token.scope}`,
  });
  return NextResponse.redirect(new URL("/sessions/new?github=connected", requestUrl.origin));
}

export const GET = withObservability("github.connect.callback", handleGET);
