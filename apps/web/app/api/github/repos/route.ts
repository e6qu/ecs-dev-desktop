// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { defineAbilityFor } from "@edd/authz";
import { z } from "zod";

import { authenticate, badRequest, conflict, forbidden, isResponse } from "../../../../lib/api";
import { auditActor, recordAudit } from "../../../../lib/audit";
import { getGitCredentials, gitCredentialsEnabled } from "../../../../lib/git-credentials";
import { createRepo, listRepos } from "../../../../lib/github";

/**
 * GitHub repo endpoints for the session launcher. The user's token is read from
 * the encrypted store server-side and never returned to the browser. A user with
 * no stored GitHub credential (e.g. signed in via Entra) gets 409.
 */
async function githubToken(ownerId: string): Promise<string | null> {
  if (!gitCredentialsEnabled()) return null;
  return getGitCredentials().fetch(ownerId);
}

// GET /api/github/repos — repos the authenticated user can access.
export async function GET(req: Request) {
  const principal = await authenticate(req);
  if (isResponse(principal)) return principal;

  const token = await githubToken(principal.id);
  if (token === null) return conflict("GitHub account not connected — sign in with GitHub");

  const repos = await listRepos(token);
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

  const token = await githubToken(principal.id);
  if (token === null) return conflict("GitHub account not connected — sign in with GitHub");

  const repo = await createRepo(token, parsed.data);
  await recordAudit({
    actor: auditActor(principal),
    action: "repo.create",
    target: repo.fullName,
    detail: parsed.data.private ? "private" : "public",
  });
  return NextResponse.json({ repo }, { status: 201 });
}
