// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_GITHUB_API_URL } from "@edd/config";
import { z } from "zod";

import { GITHUB_API_URL_ENV } from "./constants";

/**
 * GitHub OAuth profiles don't carry team membership, so the role-granting groups
 * are fetched from `GET /user/teams` with the access token (needs the `read:org`
 * scope). Each team becomes an `org/team` id, matched against
 * `EDD_ADMIN_GROUPS` / `EDD_MEMBER_GROUPS` exactly like Entra group object-ids.
 */

const teamSchema = z.object({
  slug: z.string(),
  organization: z.object({ login: z.string() }),
});
const teamsSchema = z.array(teamSchema);

type Team = z.infer<typeof teamSchema>;

/** `org/team` group identifier (e.g. `acme/platform-admins`). */
export function teamGroupId(team: Team): string {
  return `${team.organization.login}/${team.slug}`;
}

/** GitHub REST base — the bleephub sim / GitHub Enterprise via env, else public GitHub. */
export function githubApiBaseUrl(): string {
  return process.env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL;
}

/** Minimal `fetch` surface so tests inject a fake without a global stub. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

export interface FetchTeamsDeps {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * The authenticated user's GitHub teams as `org/team` group ids. Fails loudly on
 * a non-OK response — a teams-fetch failure must not silently downgrade the
 * user's role (a security-relevant silent fallback, see `AGENTS.md` §6.5).
 */
export async function fetchGithubTeamGroups(deps: FetchTeamsDeps): Promise<string[]> {
  const { accessToken, baseUrl = githubApiBaseUrl(), fetchImpl = fetch } = deps;
  // per_page=100 covers all but pathological membership; a user in >100 teams
  // would have additional pages we don't follow (acceptable for role mapping).
  const res = await fetchImpl(`${baseUrl}/user/teams?per_page=100`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub /user/teams failed: ${res.status.toString()} ${res.statusText}`);
  }
  return teamsSchema.parse(await res.json()).map(teamGroupId);
}
