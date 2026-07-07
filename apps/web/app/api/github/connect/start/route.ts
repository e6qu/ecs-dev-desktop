// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, isResponse } from "../../../../../lib/api";
import {
  githubAuthorizeUrl,
  githubOAuthConfigFromEnv,
  signGithubConnectState,
} from "../../../../../lib/github-connect";
import { withObservability } from "../../../../../lib/observability";

async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const requestUrl = new URL(req.url);
  const redirectUri = new URL("/api/github/connect/callback", requestUrl.origin).toString();
  const state = signGithubConnectState(principal.id, new Date());
  return NextResponse.redirect(githubAuthorizeUrl(githubOAuthConfigFromEnv(), redirectUri, state));
}

export const GET = withObservability("github.connect.start", handleGET);
