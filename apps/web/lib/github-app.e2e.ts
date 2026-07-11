// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerId } from "@edd/core";
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
  // Real now: the app JWT must be currently valid against the target's clock
  // (the unit tests pin a fixed time; a live target rejects an expired JWT).
  const nowSec = Math.floor(Date.now() / 1000);

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

  it("drives InstallationGitProvider end-to-end (installation-scoped REST + git credential)", async () => {
    const provider = await getGitProvider(ownerId("ignored-in-app-mode"));
    expect(provider).not.toBeNull();

    // listRepos goes through the full chain: app JWT → installation token →
    // GET /installation/repositories. We assert the call succeeds (the
    // installation can enumerate its repos); contents depend on what the
    // installation is granted, which the coordinates own.
    const page = await provider?.listRepos();
    expect(Array.isArray(page?.repos)).toBe(true);

    // Scoped to exactly the one repo (owner + name) — the token GitHub mints is limited
    // to that repository with only `contents`, not the installation's whole org.
    const cred = await provider?.gitCredential({ owner: coords.org, name: coords.repo });
    expect(cred?.username).toBe("x-access-token");
    expect(cred?.token.startsWith("ghs_")).toBe(true);
  });
});
