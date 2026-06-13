// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeAll, describe, expect, it } from "vitest";

import { listAppInstallations, mintInstallationToken, type GitHubAppConfig } from "./git-app-auth";
import { getGitProvider } from "./git-provider";
import {
  gitHubAppCoordinatesFromEnv,
  type GitHubAppCoordinates,
} from "./test-support/github-app-coords";

/**
 * GitHub **App** flow: sign an RS256 app JWT with the app's private key → exchange
 * it for an installation access token (`ghs_…`) → use it for installation-scoped
 * REST, all through OUR `InstallationGitProvider`.
 *
 * Pure coordinate-driven (AGENTS.md §6.9): the test reads only its coordinates
 * (api base, app id, private key, org, repo) from env and is identical against any
 * target — it has no notion of "sim" vs. "real". Supply the coordinates to run it
 * (a real GitHub/GHES App, or any target that can present a pre-registered App);
 * with none, it skips.
 */
const coordinates = gitHubAppCoordinatesFromEnv();
const suite = coordinates === null ? describe.skip : describe;

suite("GitHub App flow (app JWT → installation token → REST), coordinate-driven", () => {
  let coords: GitHubAppCoordinates;
  let cfg: GitHubAppConfig;
  const nowSec = Math.floor(Date.parse("2026-06-13T00:00:00Z") / 1000);

  beforeAll(() => {
    const c = gitHubAppCoordinatesFromEnv();
    if (c === null) throw new Error("GitHub App coordinates required");
    coords = c;
    cfg = { appId: c.appId, privateKeyPem: c.privateKeyPem, apiBase: c.apiBase };
  });

  it("mints an installation access token from a signed app JWT", async () => {
    const installs = await listAppInstallations(cfg, nowSec);
    const inst = installs.find((i) => i.account?.login === coords.org);
    if (inst === undefined) throw new Error(`no App installation on ${coords.org}`);

    const token = await mintInstallationToken(cfg, inst.id, nowSec);
    // GitHub issues installation tokens with the `ghs_` prefix.
    expect(token.token.startsWith("ghs_")).toBe(true);
  });

  it("drives InstallationGitProvider end-to-end (list repos + git credential)", async () => {
    const provider = await getGitProvider("ignored-in-app-mode");
    expect(provider).not.toBeNull();

    const repos = await provider?.listRepos();
    expect(repos?.map((r) => r.fullName)).toContain(`${coords.org}/${coords.repo}`);

    const cred = await provider?.gitCredential(coords.org);
    expect(cred?.username).toBe("x-access-token");
    expect(cred?.token.startsWith("ghs_")).toBe(true);
  });
});
