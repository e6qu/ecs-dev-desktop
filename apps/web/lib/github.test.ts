// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { createRepo, listNamespaces, listRepos } from "./github";

const TOKEN = "ghp_test_not_real";

/** Build a fetch that routes by URL substring to canned JSON responses. Each
 * entry: [match, body, init?]. */
function router(
  routes: { match: string; body: unknown; status?: number; headers?: Record<string, string> }[],
): { impl: typeof fetch; calls: { url: string; method: string; body?: string }[] } {
  const calls: { url: string; method: string; body?: string }[] = [];
  const impl = ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const route = routes.find((r) => u.includes(r.match));
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: route.headers,
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

const repoJson = (fullName: string, priv = false) => ({
  full_name: fullName,
  name: fullName.split("/")[1],
  owner: { login: fullName.split("/")[0] },
  private: priv,
  default_branch: "main",
  clone_url: `https://github.com/${fullName}.git`,
  html_url: `https://github.com/${fullName}`,
});

describe("github adapter", () => {
  it("lists the user's accessible repos, mapped to summaries", async () => {
    const { impl } = router([
      { match: "/user/repos", body: [repoJson("alice/widgets", true), repoJson("acme/api")] },
    ]);
    const page = await listRepos(TOKEN, 1, impl);
    expect(page.repos.map((r) => r.fullName)).toEqual(["alice/widgets", "acme/api"]);
    expect(page.repos[0]?.private).toBe(true);
    expect(page.repos[0]?.cloneUrl).toBe("https://github.com/alice/widgets.git");
    expect(page.hasMore).toBe(false);
  });

  it('reports hasMore from the Link: rel="next" response header', async () => {
    const { impl, calls } = router([
      {
        match: "/user/repos",
        body: [repoJson("alice/widgets")],
        headers: {
          link: '<https://api.example.test/user/repos?page=2>; rel="next", <https://api.example.test/user/repos?page=5>; rel="last"',
        },
      },
    ]);
    const page = await listRepos(TOKEN, 2, impl);
    expect(page.hasMore).toBe(true);
    expect(calls[0]?.url).toContain("page=2");
  });

  it("marks create permission per namespace from token scope + org policy", async () => {
    const { impl } = router([
      { match: "/user/orgs", body: [{ login: "acme" }, { login: "open-org" }] },
      { match: "/orgs/acme", body: { members_can_create_repositories: false } },
      { match: "/orgs/open-org", body: { members_can_create_repositories: true } },
      { match: "/user", body: { login: "alice" }, headers: { "x-oauth-scopes": "repo, read:org" } },
    ]);
    const ns = await listNamespaces(TOKEN, impl);
    const byLogin = new Map(ns.map((n) => [n.login, n]));
    expect(byLogin.get("alice")?.canCreate).toBe(true); // scope present
    expect(byLogin.get("acme")?.canCreate).toBe(false); // org forbids developer creation
    expect(byLogin.get("acme")?.reason).toMatch(/role/i);
    expect(byLogin.get("open-org")?.canCreate).toBe(true);
  });

  it("grays out create everywhere when the token lacks the repo scope", async () => {
    const { impl } = router([
      { match: "/user/orgs", body: [{ login: "acme" }] },
      {
        match: "/user",
        body: { login: "alice" },
        headers: { "x-oauth-scopes": "read:user,read:org" },
      },
    ]);
    const ns = await listNamespaces(TOKEN, impl);
    expect(ns.every((n) => !n.canCreate)).toBe(true);
    expect(ns[0]?.reason).toMatch(/scope/i);
  });

  it("creates a personal repo via /user/repos", async () => {
    const { impl, calls } = router([
      { match: "/user/repos", body: repoJson("alice/new-thing", true) },
    ]);
    const repo = await createRepo(
      TOKEN,
      { owner: "alice", name: "new-thing", private: true, isPersonal: true },
      impl,
    );
    expect(repo.fullName).toBe("alice/new-thing");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/user/repos");
    expect(post?.body).toContain('"auto_init":true');
  });

  it("creates an org repo via /orgs/:org/repos", async () => {
    const { impl, calls } = router([{ match: "/orgs/acme/repos", body: repoJson("acme/svc") }]);
    const repo = await createRepo(
      TOKEN,
      { owner: "acme", name: "svc", private: false, isPersonal: false },
      impl,
    );
    expect(repo.fullName).toBe("acme/svc");
    expect(calls.find((c) => c.method === "POST")?.url).toContain("/orgs/acme/repos");
  });
});
