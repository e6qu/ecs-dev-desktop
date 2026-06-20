// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { GITHUB_API_URL_ENV } from "./constants";
import {
  fetchGithubTeamGroups,
  githubApiBaseUrl,
  teamGroupId,
  type FetchLike,
} from "./github-teams";

function fakeFetch(
  body: unknown,
  res: { ok?: boolean; status?: number; statusText?: string } = {},
): FetchLike {
  return () =>
    Promise.resolve({
      ok: res.ok ?? true,
      status: res.status ?? 200,
      statusText: res.statusText ?? "OK",
      json: () => Promise.resolve(body),
    });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("teamGroupId", () => {
  it("formats org/team", () => {
    expect(teamGroupId({ slug: "platform-admins", organization: { login: "acme" } })).toBe(
      "acme/platform-admins",
    );
  });
});

describe("fetchGithubTeamGroups", () => {
  it("maps the user's teams to org/team group ids", async () => {
    const groups = await fetchGithubTeamGroups({
      accessToken: "t",
      baseUrl: "https://api.example",
      fetchImpl: fakeFetch([
        { slug: "admins", organization: { login: "acme" } },
        { slug: "devs", organization: { login: "acme" } },
      ]),
    });
    expect(groups).toEqual(["acme/admins", "acme/devs"]);
  });

  it("returns [] when the user is in no teams", async () => {
    expect(await fetchGithubTeamGroups({ accessToken: "t", fetchImpl: fakeFetch([]) })).toEqual([]);
  });

  it("fails loudly on a non-OK response (no silent role downgrade)", async () => {
    await expect(
      fetchGithubTeamGroups({
        accessToken: "t",
        fetchImpl: fakeFetch({}, { ok: false, status: 403, statusText: "Forbidden" }),
      }),
    ).rejects.toThrow(/403/);
  });

  it("follows pagination so a role-granting team on a later page is not dropped", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      slug: `t${String(i)}`,
      organization: { login: "acme" },
    }));
    const page2 = [{ slug: "platform-admins", organization: { login: "acme" } }];
    const pageAware: FetchLike = (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(url.includes("page=2") ? page2 : page1),
      });
    const groups = await fetchGithubTeamGroups({
      accessToken: "t",
      baseUrl: "https://api.example",
      fetchImpl: pageAware,
    });
    expect(groups).toHaveLength(101); // page 1 (100, full → continue) + page 2 (1, partial → stop)
    expect(groups).toContain("acme/platform-admins");
  });

  it("calls /user/teams with the bearer token", async () => {
    let calledUrl = "";
    let authHeader = "";
    const spy: FetchLike = (url, init) => {
      calledUrl = url;
      authHeader = init.headers.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve([]),
      });
    };
    await fetchGithubTeamGroups({
      accessToken: "abc",
      baseUrl: "https://api.example",
      fetchImpl: spy,
    });
    expect(calledUrl).toContain("https://api.example/user/teams");
    expect(authHeader).toBe("Bearer abc");
  });
});

describe("githubApiBaseUrl", () => {
  it("defaults to public GitHub", () => {
    expect(githubApiBaseUrl()).toBe("https://api.github.com");
  });

  it("honours the env override (e.g. the github sim)", () => {
    vi.stubEnv(GITHUB_API_URL_ENV, "http://127.0.0.1:9000/api/v3");
    expect(githubApiBaseUrl()).toBe("http://127.0.0.1:9000/api/v3");
  });
});
