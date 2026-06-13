// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_GITHUB_API_URL } from "@edd/config";
import { z } from "zod";

import { GITHUB_API_URL_ENV } from "./constants";
import type { Namespace, RepoSummary } from "./github-types";

export type { Namespace, RepoSummary } from "./github-types";

/**
 * Server-side GitHub repo operations for the session launcher: list the repos a
 * user can access, list the namespaces they may create repos in (with a
 * permission flag so the UI can gray out "Create" with a reason), and create a
 * repo. All calls use the user's token server-side — it never reaches the
 * browser. Endpoint-only: `AUTH_GITHUB_API_URL` points at GHES/bleephub, else
 * public GitHub.
 */
function apiBase(): string {
  return process.env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export const repoSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  default_branch: z.string(),
  clone_url: z.string(),
  html_url: z.string(),
});

export function toRepoSummary(r: z.infer<typeof repoSchema>): RepoSummary {
  return {
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
    cloneUrl: r.clone_url,
    htmlUrl: r.html_url,
  };
}

/** Repos the user can access (owner/collaborator/org-member), most-recent first.
 * One page of 100 (a fuller browser would paginate via the Link header). */
export async function listRepos(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoSummary[]> {
  const res = await fetchImpl(
    `${apiBase()}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
    { headers: ghHeaders(token) },
  );
  if (!res.ok) throw new Error(`GitHub /user/repos failed: ${String(res.status)}`);
  return z
    .array(repoSchema)
    .parse(await res.json())
    .map(toRepoSummary);
}

const NO_SCOPE_REASON = "the GitHub authorization is missing the 'repo' scope";
const ORG_DENIED_REASON = "your role in this organization cannot create repositories";

/** The namespaces the user can target, with per-namespace create permission. The
 * token's granted scopes (from the `X-OAuth-Scopes` header) gate creation; each
 * org additionally honors `members_can_create_repositories`. */
export async function listNamespaces(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Namespace[]> {
  const userRes = await fetchImpl(`${apiBase()}/user`, { headers: ghHeaders(token) });
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${String(userRes.status)}`);
  const user = z.object({ login: z.string() }).parse(await userRes.json());
  const scopes = (userRes.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const scopeAllowsCreate = scopes.includes("repo") || scopes.includes("public_repo");
  const scopeReason = scopeAllowsCreate ? undefined : NO_SCOPE_REASON;

  const namespaces: Namespace[] = [
    {
      login: user.login,
      kind: "user",
      canCreate: scopeAllowsCreate,
      ...(scopeReason && { reason: scopeReason }),
    },
  ];

  const orgsRes = await fetchImpl(`${apiBase()}/user/orgs?per_page=100`, {
    headers: ghHeaders(token),
  });
  if (!orgsRes.ok) throw new Error(`GitHub /user/orgs failed: ${String(orgsRes.status)}`);
  const orgs = z.array(z.object({ login: z.string() })).parse(await orgsRes.json());

  for (const org of orgs) {
    let canCreate = scopeAllowsCreate;
    let reason = scopeReason;
    if (scopeAllowsCreate) {
      const detail = await fetchImpl(`${apiBase()}/orgs/${org.login}`, {
        headers: ghHeaders(token),
      });
      if (detail.ok) {
        const parsed = z
          .object({ members_can_create_repositories: z.boolean().optional() })
          .safeParse(await detail.json());
        if (parsed.success && parsed.data.members_can_create_repositories === false) {
          canCreate = false;
          reason = ORG_DENIED_REASON;
        }
      }
    }
    namespaces.push({ login: org.login, kind: "org", canCreate, ...(reason && { reason }) });
  }
  return namespaces;
}

export interface CreateRepoParams {
  owner: string;
  name: string;
  private: boolean;
  description?: string;
  /** True ⇒ create under the user's account (`/user/repos`); false ⇒ org. */
  isPersonal: boolean;
}

/** Create a repo (initialized with a README so a session can clone it). */
export async function createRepo(
  token: string,
  params: CreateRepoParams,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoSummary> {
  const url = params.isPersonal
    ? `${apiBase()}/user/repos`
    : `${apiBase()}/orgs/${params.owner}/repos`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...ghHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      name: params.name,
      private: params.private,
      description: params.description ?? "",
      auto_init: true,
    }),
  });
  if (!res.ok) throw new Error(`GitHub create repo failed: ${String(res.status)}`);
  return toRepoSummary(repoSchema.parse(await res.json()));
}
