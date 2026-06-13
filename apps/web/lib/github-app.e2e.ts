// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeAll, describe, expect, it } from "vitest";

import { GITHUB_APP_ID_ENV, GITHUB_APP_KEY_ENV } from "./constants";
import { listAppInstallations, mintInstallationToken, type GitHubAppConfig } from "./git-app-auth";
import { getGitProvider } from "./git-provider";
import {
  ensureGitHubAppCoordinates,
  type GitHubAppCoordinates,
} from "./test-support/github-app-coords";

/**
 * GitHub **App** flow: sign an RS256 app JWT with the app's private key → exchange
 * it for an installation access token (`ghs_…`) → use it for installation-scoped
 * REST, all through OUR `InstallationGitProvider`.
 *
 * Coordinate-driven (AGENTS.md §6.8): the test consumes only the resolved
 * coordinates (api base, app id, private key, org, repo) and is identical whether
 * those point at real GitHub, GHES, or the bleephub sim — it never learns which.
 * Set the App coordinates via env to target real GitHub; otherwise the bleephub
 * harness provisions an equivalent App. See `test-support/github-app-coords.ts`.
 */
describe("GitHub App flow (app JWT → installation token → REST), coordinate-driven", () => {
  let coords: GitHubAppCoordinates;
  let cfg: GitHubAppConfig;
  const nowSec = Math.floor(Date.parse("2026-06-13T00:00:00Z") / 1000);

  beforeAll(async () => {
    coords = await ensureGitHubAppCoordinates();
    cfg = { appId: coords.appId, privateKeyPem: coords.privateKeyPem, apiBase: coords.apiBase };
  });

  it("mints an installation access token from a signed app JWT", async () => {
    const installs = await listAppInstallations(cfg, nowSec);
    const inst = installs.find((i) => i.account?.login === coords.org);
    if (inst === undefined) throw new Error(`no App installation on ${coords.org}`);

    const token = await mintInstallationToken(cfg, inst.id, nowSec);
    // GitHub (real + sim) issues installation tokens with the `ghs_` prefix.
    expect(token.token.startsWith("ghs_")).toBe(true);
  });

  it("drives InstallationGitProvider end-to-end (list repos + git credential)", async () => {
    process.env[GITHUB_APP_ID_ENV] = cfg.appId;
    process.env[GITHUB_APP_KEY_ENV] = cfg.privateKeyPem;
    try {
      const provider = await getGitProvider("ignored-in-app-mode");
      expect(provider).not.toBeNull();

      const repos = await provider?.listRepos();
      expect(repos?.map((r) => r.fullName)).toContain(`${coords.org}/${coords.repo}`);

      const cred = await provider?.gitCredential(coords.org);
      expect(cred?.username).toBe("x-access-token");
      expect(cred?.token.startsWith("ghs_")).toBe(true);
    } finally {
      Reflect.deleteProperty(process.env, GITHUB_APP_ID_ENV);
      Reflect.deleteProperty(process.env, GITHUB_APP_KEY_ENV);
    }
  });
});
