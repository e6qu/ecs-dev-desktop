// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, conflict, isResponse } from "../../../../lib/api";
import { getGitProvider } from "../../../../lib/git-provider";
import { withObservability } from "../../../../lib/observability";

// GET /api/github/namespaces — the namespaces (user + orgs, or App installations)
// the caller may create a repo under, each with a canCreate flag + reason so the
// UI can gray out "Create" with an explanation. Resolved server-side via the
// active provider.
async function handleGET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const provider = await getGitProvider(principal.id);
  if (provider === null) {
    return conflict("GitHub account not connected — sign in with GitHub");
  }
  const namespaces = await provider.listNamespaces();
  return NextResponse.json({ namespaces });
}

export const GET = withObservability("github.namespaces", handleGET);
