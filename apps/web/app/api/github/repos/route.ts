// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { defineAbilityFor } from "@edd/authz";
import { z } from "zod";

import { authenticate, badRequest, conflict, forbidden, isResponse } from "../../../../lib/api";
import { auditActor, recordAudit } from "../../../../lib/audit";
import { getGitProvider } from "../../../../lib/git-provider";

/**
 * GitHub repo endpoints for the session launcher. Operations go through the
 * active {@link getGitProvider} (user OAuth token, or a GitHub App installation
 * token when the app is configured) — server-side only, never the browser. No
 * available credential (e.g. signed in via Entra, no GitHub) → 409.
 */
const NOT_CONNECTED = "GitHub account not connected — sign in with GitHub";

// GET /api/github/repos — repos the authenticated caller can access.
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const provider = await getGitProvider(principal.id);
  if (provider === null) return conflict(NOT_CONNECTED);

  const repos = await provider.listRepos();
  return NextResponse.json({ repos });
}

const createRepoRequest = z.object({
  owner: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, "invalid repo name"),
  private: z.boolean(),
  description: z.string().max(350).optional(),
  isPersonal: z.boolean(),
});

// POST /api/github/repos — create a repo the user will start a session in.
export async function POST(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;
  // Creating a repo is a member+ action (same gate as creating a workspace).
  if (!defineAbilityFor(principal).can("create", "Workspace")) return forbidden();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest();
  }
  const parsed = createRepoRequest.safeParse(raw);
  if (!parsed.success) return badRequest();

  const provider = await getGitProvider(principal.id);
  if (provider === null) return conflict(NOT_CONNECTED);

  const repo = await provider.createRepo(parsed.data);
  await recordAudit({
    actor: auditActor(principal),
    action: "repo.create",
    target: repo.fullName,
    detail: parsed.data.private ? "private" : "public",
  });
  return NextResponse.json({ repo }, { status: 201 });
}
