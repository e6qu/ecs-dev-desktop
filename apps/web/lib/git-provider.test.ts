// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync } from "node:crypto";

import { ownerId } from "@edd/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GITHUB_API_URL_ENV, GITHUB_APP_ID_ENV, GITHUB_APP_KEY_ENV } from "./constants";
import { getGitProvider, githubAppConfig, githubAppEnabled } from "./git-provider";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ENV_VARS = [GITHUB_APP_ID_ENV, GITHUB_APP_KEY_ENV, GITHUB_API_URL_ENV];
let snapshot: Record<string, string | undefined>;
beforeEach(() => {
  snapshot = Object.fromEntries(ENV_VARS.map((v) => [v, process.env[v]]));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of ENV_VARS) {
    const value = snapshot[v];
    if (value === undefined) Reflect.deleteProperty(process.env, v);
    else process.env[v] = value;
  }
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const repo = (fullName: string, priv = false) => {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    name,
    owner: { login: owner },
    private: priv,
    default_branch: "main",
    clone_url: `https://api.example.test/${fullName}.git`,
    html_url: `https://example.test/${fullName}`,
  };
};

/** Stub the github-shaped GitHub App endpoints the provider calls. */
function stubGitHubApp(): void {
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const method = init?.method ?? "GET";
    if (u.endsWith("/app/installations?per_page=100")) {
      return Promise.resolve(
        json([
          {
            id: 7,
            target_type: "Organization",
            permissions: { administration: "write", contents: "write" },
            account: { login: "acme", type: "Organization" },
          },
        ]),
      );
    }
    if (u.endsWith("/app/installations/7/access_tokens") && method === "POST") {
      return Promise.resolve(json({ token: "ghs_inst7", expires_at: "2999-01-01T00:00:00Z" }, 201));
    }
    if (u.endsWith("/installation/repositories?per_page=100")) {
      return Promise.resolve(json({ repositories: [repo("acme/web", true)] }));
    }
    if (u.endsWith("/orgs/acme/repos") && method === "POST") {
      return Promise.resolve(json(repo("acme/new", true), 201));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${u}`));
  });
}

function enableApp(): void {
  process.env[GITHUB_APP_ID_ENV] = "12345";
  process.env[GITHUB_APP_KEY_ENV] = privateKey;
  process.env[GITHUB_API_URL_ENV] = "https://api.example.test";
}

describe("githubAppConfig", () => {
  it("is null when unset (→ user-OAuth mode)", () => {
    Reflect.deleteProperty(process.env, GITHUB_APP_ID_ENV);
    Reflect.deleteProperty(process.env, GITHUB_APP_KEY_ENV);
    expect(githubAppConfig()).toBeNull();
    expect(githubAppEnabled()).toBe(false);
  });

  it("reads app id + PEM key when set", () => {
    enableApp();
    const cfg = githubAppConfig();
    expect(cfg?.appId).toBe("12345");
    expect(cfg?.privateKeyPem).toContain("PRIVATE KEY");
    expect(githubAppEnabled()).toBe(true);
  });

  it("base64-decodes a non-PEM key value", () => {
    process.env[GITHUB_APP_ID_ENV] = "12345";
    process.env[GITHUB_APP_KEY_ENV] = Buffer.from(privateKey, "utf8").toString("base64");
    expect(githubAppConfig()?.privateKeyPem).toContain("PRIVATE KEY");
  });
});

describe("InstallationGitProvider (via getGitProvider in App mode)", () => {
  it("lists repos across the app's installations", async () => {
    enableApp();
    stubGitHubApp();
    const provider = await getGitProvider(ownerId("ignored-in-app-mode"));
    const repos = await provider?.listRepos();
    expect(repos?.map((r) => r.fullName)).toEqual(["acme/web"]);
    expect(repos?.[0]?.private).toBe(true);
  });

  it("maps installations to namespaces with canCreate from the administration permission", async () => {
    enableApp();
    stubGitHubApp();
    const provider = await getGitProvider(ownerId("x"));
    const ns = await provider?.listNamespaces();
    expect(ns).toEqual([{ login: "acme", kind: "org", canCreate: true }]);
  });

  it("creates a repo via the installation token", async () => {
    enableApp();
    stubGitHubApp();
    const provider = await getGitProvider(ownerId("x"));
    const created = await provider?.createRepo({
      owner: "acme",
      name: "new",
      private: true,
      isPersonal: false,
    });
    expect(created?.fullName).toBe("acme/new");
  });

  it("yields a git credential scoped to the repo owner's installation", async () => {
    enableApp();
    stubGitHubApp();
    const provider = await getGitProvider(ownerId("x"));
    const cred = await provider?.gitCredential("acme");
    expect(cred).toEqual({ username: "x-access-token", token: "ghs_inst7" });
  });

  it("fails closed: a repo owner with no matching installation gets NO token", async () => {
    // Must never fall back to another org's installation (over-scoped credential).
    enableApp();
    stubGitHubApp();
    const provider = await getGitProvider(ownerId("x"));
    expect(await provider?.gitCredential("not-installed-org")).toBeNull();
  });

  it("returns no credential when there is no repo context (blank session)", async () => {
    enableApp();
    stubGitHubApp();
    const provider = await getGitProvider(ownerId("x"));
    expect(await provider?.gitCredential()).toBeNull();
  });
});
