// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_GITHUB_API_URL } from "@edd/config";
import type { OwnerId } from "@edd/core";
import { z } from "zod";

import { GITHUB_API_URL_ENV, GITHUB_APP_ID_ENV, GITHUB_APP_KEY_ENV } from "./constants";
import {
  listAppInstallations,
  mintInstallationToken,
  type AppInstallation,
  type GitHubAppConfig,
} from "./git-app-auth";
import { getGitCredentials, gitCredentialsEnabled } from "./git-credentials";
import {
  createRepo,
  GitHubApiError,
  listNamespaces,
  listRepos,
  repoSchema,
  toRepoSummary,
  type CreateRepoParams,
  type RepoPage,
} from "./github";
import type { Namespace, RepoSummary } from "./github-types";

/**
 * A source of GitHub operations for the session launcher + clone/push broker.
 * Two implementations select by config:
 *  - {@link UserOAuthGitProvider} — the default: the signed-in user's OAuth token
 *    (captured at sign-in, stored encrypted).
 *  - {@link InstallationGitProvider} — a GitHub App: a per-installation token
 *    minted on demand from the app private key (no user token needed).
 * Both expose the same surface and yield a wire-identical git credential
 * (`x-access-token` + bearer), so the broker and UI are provider-agnostic.
 */
/** The single repository a workspace credential is for (`owner/name`), so a GitHub App
 * token can be scoped to exactly that repo rather than the installation's whole org.
 * Callers pass a structural `{ owner, name }` (e.g. `repoRef(repoUrl)`), so this stays
 * module-internal. */
interface GitRepoRef {
  readonly owner: string;
  readonly name: string;
}

export interface GitProvider {
  /** One page of repos, 1-indexed. */
  listRepos(page?: number): Promise<RepoPage>;
  listNamespaces(): Promise<Namespace[]>;
  createRepo(params: CreateRepoParams): Promise<RepoSummary>;
  /** HTTPS git credential to clone/push the single repo `repo`, or null when none is
   * available (no stored user token / no matching App installation). In GitHub App mode the
   * returned token is scoped to exactly `repo` with least privilege, so a workspace can never
   * obtain an installation-wide credential from a repo URL its owner chose. */
  gitCredential(repo?: GitRepoRef): Promise<{ username: string; token: string } | null>;
}

const GIT_USERNAME = "x-access-token";

function apiBase(): string {
  return process.env[GITHUB_API_URL_ENV] ?? DEFAULT_GITHUB_API_URL;
}

/** Default provider: operates as the signed-in user via their stored OAuth token. */
class UserOAuthGitProvider implements GitProvider {
  constructor(private readonly token: string) {}
  listRepos(page = 1): Promise<RepoPage> {
    return listRepos(this.token, page);
  }
  listNamespaces(): Promise<Namespace[]> {
    return listNamespaces(this.token);
  }
  createRepo(params: CreateRepoParams): Promise<RepoSummary> {
    return createRepo(this.token, params);
  }
  gitCredential(): Promise<{ username: string; token: string } | null> {
    return Promise.resolve({ username: GIT_USERNAME, token: this.token });
  }
}

const ghHeaders = (bearer: string): Record<string, string> => ({
  Authorization: `Bearer ${bearer}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

const REPO_CREATE_PERMISSION = "administration";
const NO_APP_PERMISSION_REASON =
  "the GitHub App installation lacks the 'administration' permission to create repositories";

/** Provider backed by a GitHub App: lists across the app's installations and
 * mints short-lived installation tokens on demand (cached until shortly before
 * expiry). Repo access is exactly what each installation grants. */
class InstallationGitProvider implements GitProvider {
  private installations: AppInstallation[] | undefined;
  private readonly tokenCache = new Map<number, { token: string; expSec: number }>();

  constructor(
    private readonly cfg: GitHubAppConfig,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private async listInstallations(): Promise<AppInstallation[]> {
    this.installations ??= await listAppInstallations(this.cfg, this.now());
    return this.installations;
  }

  /** A valid installation token, minted fresh when absent or within 60 s of expiry. */
  private async token(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    const nowSec = this.now();
    if (cached && cached.expSec - 60 > nowSec) return cached.token;
    const minted = await mintInstallationToken(this.cfg, installationId, nowSec);
    this.tokenCache.set(installationId, {
      token: minted.token,
      expSec: Math.floor(Date.parse(minted.expiresAt) / 1000),
    });
    return minted.token;
  }

  // Repos are merged across every installation (deduplicated by full name), which
  // doesn't map onto GitHub's single-source page cursor -- so this provider fetches
  // its one combined set on page 1 and reports no further page, rather than
  // re-fetching (and re-merging) all installations again for "page 2".
  async listRepos(page = 1): Promise<RepoPage> {
    if (page > 1) return { repos: [], hasMore: false };
    const installs = await this.listInstallations();
    const perInstall = await Promise.all(installs.map((inst) => this.reposFor(inst.id)));
    const byFullName = new Map<string, RepoSummary>();
    for (const repo of perInstall.flat()) byFullName.set(repo.fullName, repo);
    return { repos: [...byFullName.values()], hasMore: false };
  }

  private async reposFor(installationId: number): Promise<RepoSummary[]> {
    const res = await fetch(`${apiBase()}/installation/repositories?per_page=100`, {
      headers: ghHeaders(await this.token(installationId)),
    });
    if (!res.ok) throw new Error(`GitHub /installation/repositories failed: ${String(res.status)}`);
    const body = z.object({ repositories: z.array(repoSchema) }).parse(await res.json());
    return body.repositories.map(toRepoSummary);
  }

  async listNamespaces(): Promise<Namespace[]> {
    const installs = await this.listInstallations();
    return installs.map((inst) => {
      const login = inst.account?.login ?? "";
      const canCreate = inst.permissions[REPO_CREATE_PERMISSION] === "write";
      return {
        login,
        kind: inst.target_type === "Organization" ? "org" : "user",
        canCreate,
        ...(canCreate ? {} : { reason: NO_APP_PERMISSION_REASON }),
      };
    });
  }

  async createRepo(params: CreateRepoParams): Promise<RepoSummary> {
    const inst = await this.installationFor(params.owner);
    const url = params.isPersonal
      ? `${apiBase()}/user/repos`
      : `${apiBase()}/orgs/${params.owner}/repos`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...ghHeaders(await this.token(inst.id)), "content-type": "application/json" },
      body: JSON.stringify({
        name: params.name,
        private: params.private,
        description: params.description ?? "",
        auto_init: true,
      }),
    });
    if (!res.ok) throw new GitHubApiError(res.status, "App create repo");
    return toRepoSummary(repoSchema.parse(await res.json()));
  }

  async gitCredential(repo?: GitRepoRef): Promise<{ username: string; token: string } | null> {
    // No repo context (a blank session) → no credential is needed.
    if (repo === undefined) return null;
    const matched = (await this.listInstallations()).find((i) => i.account?.login === repo.owner);
    // Fail closed: a repo whose owner has no matching App installation gets NO token. Never
    // fall back to another installation — that would mint a token scoped to an UNRELATED org
    // (over-scoped credential issuance + a §6.5 silent fallback). The broker route → 404.
    if (matched === undefined) return null;
    // Least privilege: scope the token to EXACTLY this one repository with only `contents`
    // access (clone/push). Without this, the returned token carried the installation's whole
    // org repo set + granted permissions, so a workspace owner could name any repo the App can
    // reach in their repoUrl and receive an org-wide credential (broken access control). The
    // scoped token is NOT cached — it's per-repo and short-lived, minted on the credential path.
    const minted = await mintInstallationToken(this.cfg, matched.id, this.now(), fetch, {
      repositories: [repo.name],
      permissions: { contents: "write" },
    });
    return { username: GIT_USERNAME, token: minted.token };
  }

  private async installationFor(owner: string): Promise<AppInstallation> {
    const inst = (await this.listInstallations()).find((i) => i.account?.login === owner);
    if (inst === undefined) {
      throw new Error(`no GitHub App installation for '${owner}'`);
    }
    return inst;
  }
}

/** The GitHub App config from env, or null when not configured (→ user-OAuth
 * mode). The private key may be supplied as a PEM or base64-encoded PEM. */
export function githubAppConfig(): GitHubAppConfig | null {
  const appId = process.env[GITHUB_APP_ID_ENV];
  const rawKey = process.env[GITHUB_APP_KEY_ENV];
  if (appId === undefined || appId.length === 0 || rawKey === undefined || rawKey.length === 0) {
    return null;
  }
  const privateKeyPem = rawKey.includes("PRIVATE KEY")
    ? rawKey
    : Buffer.from(rawKey, "base64").toString("utf8");
  return { appId, privateKeyPem, apiBase: apiBase() };
}

/** True when the platform is configured to act as a GitHub App. */
export function githubAppEnabled(): boolean {
  return githubAppConfig() !== null;
}

/**
 * The active provider for `ownerId`, or null when no credential is available.
 * GitHub App mode (when configured) ignores the per-user token; user-OAuth mode
 * reads the owner's stored token (null ⇒ the caller returns 409 "not connected").
 */
export async function getGitProvider(ownerId: OwnerId): Promise<GitProvider | null> {
  const appCfg = githubAppConfig();
  if (appCfg !== null) return new InstallationGitProvider(appCfg);
  if (!gitCredentialsEnabled()) return null;
  const token = await getGitCredentials().fetch(ownerId);
  return token === null ? null : new UserOAuthGitProvider(token);
}
