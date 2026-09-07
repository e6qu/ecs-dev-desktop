// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, conflict, isResponse } from "../../../../../lib/api";
import { gitIntegration } from "../../../../../lib/git-integration";
import {
  githubAuthorizeUrl,
  githubOAuthConfigFromEnv,
  signGithubConnectState,
} from "../../../../../lib/github-connect";
import { withObservability } from "../../../../../lib/observability";

async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  // A deployment without GitHub OAuth linking (Shauth-only sign-in with no
  // AUTH_GITHUB_ID/SECRET) cannot honour this: say so, rather than throwing a 500 from
  // the config reader. The launcher does not offer the link in that state either.
  if (gitIntegration().tokens !== "oauth") {
    return conflict(
      "GitHub account linking is not configured on this deployment; ask an admin to configure a GitHub App (EDD_GITHUB_APP_ID/EDD_GITHUB_APP_KEY) or GitHub sign-in (AUTH_GITHUB_ID/AUTH_GITHUB_SECRET), or use a GitHub SSH key from Settings",
    );
  }
  const requestUrl = new URL(req.url);
  const redirectUri = new URL("/api/github/connect/callback", requestUrl.origin).toString();
  const state = signGithubConnectState(principal.id, new Date());
  return NextResponse.redirect(githubAuthorizeUrl(githubOAuthConfigFromEnv(), redirectUri, state));
}

export const GET = withObservability("github.connect.start", handleGET);
