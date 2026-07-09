// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_GITHUB_API_URL } from "@edd/config";
import { z } from "zod";

import { GITHUB_API_URL_ENV } from "./constants";

/**
 * GitHub OAuth profiles don't carry team membership, so the role-granting groups
 * are fetched from `GET /user/teams` with the access token (needs the `read:org`
 * scope). Each team becomes an `org/team` id, matched against
 * `EDD_ADMIN_GROUPS` / `EDD_DEVELOPER_GROUPS` exactly like Entra group object-ids.
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

/** GitHub REST base — the github sim / GitHub Enterprise via env, else public GitHub. */
export function githubApiBaseUrl(): string {
  return process.env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL;
}

/** Minimal `fetch` surface so tests inject a fake without a global stub. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

interface FetchTeamsDeps {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * The authenticated user's GitHub teams as `org/team` group ids. Fails loudly on
 * a non-OK response — a teams-fetch failure must not silently downgrade the
 * user's role (a security-relevant silent fallback, see `AGENTS.md` §6.5).
 */
/** Teams per page (GitHub's max). */
const TEAMS_PER_PAGE = 100;
/** Hard page cap so we never loop forever — fail loud past it rather than silently
 * truncating the team list (which would downgrade a role granted by a later page). */
const MAX_TEAM_PAGES = 20;

export async function fetchGithubTeamGroups(deps: FetchTeamsDeps): Promise<string[]> {
  const { accessToken, baseUrl = githubApiBaseUrl(), fetchImpl = fetch } = deps;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Follow ALL pages: a role-granting team on page 2+ must not be silently dropped
  // (a security-relevant truncation, §6.5). A page shorter than the page size is the
  // last; exceeding the hard cap throws rather than under-reporting the user's teams.
  const groups: string[] = [];
  for (let page = 1; page <= MAX_TEAM_PAGES; page++) {
    const res = await fetchImpl(
      `${baseUrl}/user/teams?per_page=${String(TEAMS_PER_PAGE)}&page=${String(page)}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`GitHub /user/teams failed: ${res.status.toString()} ${res.statusText}`);
    }
    const teams = teamsSchema.parse(await res.json());
    groups.push(...teams.map(teamGroupId));
    if (teams.length < TEAMS_PER_PAGE) return groups;
  }
  throw new Error(
    `GitHub /user/teams exceeded ${String(MAX_TEAM_PAGES)} pages — refusing to silently ` +
      `truncate the team list (role mapping)`,
  );
}
