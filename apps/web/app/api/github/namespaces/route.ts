// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { authenticate, conflict, isResponse } from "../../../../lib/api";
import { getGitCredentials, gitCredentialsEnabled } from "../../../../lib/git-credentials";
import { listNamespaces } from "../../../../lib/github";

// GET /api/github/namespaces — the namespaces (user + orgs) the caller may
// create a repo under, each with a canCreate flag + reason so the UI can gray
// out "Create" with an explanation. Token read server-side from the store.
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  if (!gitCredentialsEnabled()) {
    return conflict("GitHub account not connected — sign in with GitHub");
  }
  const token = await getGitCredentials().fetch(principal.id);
  if (token === null) return conflict("GitHub account not connected — sign in with GitHub");

  const namespaces = await listNamespaces(token);
  return NextResponse.json({ namespaces });
}
