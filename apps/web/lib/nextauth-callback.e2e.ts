// SPDX-License-Identifier: AGPL-3.0-or-later
// Auth.js CALLBACK-ROUTE e2e: drives the real exported NextAuth handlers (the
// exact functions `/api/auth/[...nextauth]/route.ts` re-exports) through the
// full OAuth/OIDC dance against the live sims — signin → IdP redirect → real
// code issuance over HTTP → callback (token exchange, JWKS/id_token checks) →
// session with the mapped role. The earlier auth e2e prove the IdP protocol
// helpers; this proves the Auth.js route wiring around them.
//
// Endpoint-only (§6.8): AUTH_GITHUB_URL/AUTH_GITHUB_API_URL point the standard
// GHES options at github; AUTH_MICROSOFT_ENTRA_ID_ISSUER points OIDC
// discovery at the Azure sim. No sim-specific code paths.
import { aws, github, entra, ENTRA_TENANT } from "@edd/config";
import { createDynamoClient, dropTable, ensureTable } from "@edd/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { ADMIN_GROUPS_ENV, GITHUB_API_URL_ENV, GITHUB_URL_ENV } from "./constants";
import {
  githubApprove,
  githubExchangeCode,
  githubProvisionTeam,
  githubSession,
} from "./test-support/github-oauth";
import { acquireGraphToken, provisionEntraUserWithGroup } from "./test-support/entra-graph";

const ORIGIN = "http://localhost:3000";
const USER = "admin";
const ORG = "acme";
const TEAM = "platform-admins";
const OAUTH_APP = { id: "edd", secret: "secret" };
const ENTRA_APP = { id: "edd-e2e-client", secret: "edd-e2e-secret" };
const TEST_TABLE = "ecs-dev-des-web-nextauth-callback-e2e";

// Provider + role env BEFORE auth.ts is imported (it reads env at module load).
process.env.AUTH_SECRET = "edd-callback-e2e-secret";
process.env.DYNAMODB_ENDPOINT ??= aws.endpoint;
process.env.DYNAMODB_TABLE = TEST_TABLE;
process.env.AUTH_TRUST_HOST = "1";
process.env.AUTH_GITHUB_ID = OAUTH_APP.id;
process.env.AUTH_GITHUB_SECRET = OAUTH_APP.secret;
process.env[GITHUB_URL_ENV] = github.url;
process.env[GITHUB_API_URL_ENV] = github.apiUrl;
process.env.AUTH_MICROSOFT_ENTRA_ID_ID = ENTRA_APP.id;
process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = ENTRA_APP.secret;
process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = `${entra.authority}/v2.0`;
process.env[ADMIN_GROUPS_ENV] = `${ORG}/${TEAM}`;

const csrfSchema = z.object({ csrfToken: z.string() });
const sessionSchema = z.object({
  user: z.object({ id: z.string(), role: z.enum(["viewer", "developer", "admin"]) }),
});

type Handler = (req: Request) => Promise<Response>;
let GET: Handler;
let POST: Handler;

/** Accumulate Set-Cookie values like a browser cookie jar. */
function absorb(jar: Map<string, string>, res: Response): void {
  for (const setCookie of res.headers.getSetCookie()) {
    const pair = setCookie.split(";")[0];
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar: Map<string, string>): string =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

/** csrf → signin: returns the IdP authorize URL Auth.js redirects to.
 * `extraQuery` params on the signin request are forwarded into the authorize
 * URL by Auth.js (e.g. the standard OIDC `login_hint`). */
async function beginSignIn(
  jar: Map<string, string>,
  provider: string,
  extraQuery?: Record<string, string>,
): Promise<string> {
  const csrfRes = await GET(new Request(`${ORIGIN}/api/auth/csrf`));
  absorb(jar, csrfRes);
  const { csrfToken } = csrfSchema.parse(await csrfRes.json());

  const signinQuery =
    extraQuery === undefined ? "" : `?${new URLSearchParams(extraQuery).toString()}`;
  const signinRes = await POST(
    new Request(`${ORIGIN}/api/auth/signin/${provider}${signinQuery}`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(jar),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${ORIGIN}/workspaces` }).toString(),
    }),
  );
  absorb(jar, signinRes);
  expect(signinRes.status).toBe(302);
  const location = signinRes.headers.get("location");
  if (location === null) throw new Error("signin returned no redirect");
  return location;
}

/** Complete the callback leg and return the session (role already mapped). */
async function finishSignIn(
  jar: Map<string, string>,
  callbackLocation: string,
): Promise<z.infer<typeof sessionSchema>> {
  const cbRes = await GET(
    new Request(callbackLocation, { headers: { cookie: cookieHeader(jar) } }),
  );
  absorb(jar, cbRes);
  expect(cbRes.status, `callback did not succeed: ${cbRes.headers.get("location") ?? ""}`).toBe(
    302,
  );
  expect(cbRes.headers.get("location")).toBe(`${ORIGIN}/workspaces`);

  const sessionRes = await GET(
    new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: cookieHeader(jar) } }),
  );
  return sessionSchema.parse(await sessionRes.json());
}

describe("Auth.js callback routes against the live sims", { timeout: 60_000 }, () => {
  const client = createDynamoClient();
  beforeAll(async () => {
    await dropTable(client, TEST_TABLE);
    await ensureTable(client, TEST_TABLE);
    // Import the real route module AFTER env is in place.
    const route = await import("../app/api/auth/[...nextauth]/route");
    GET = route.GET as Handler;
    POST = route.POST as Handler;
  });

  afterAll(async () => {
    await dropTable(client, TEST_TABLE);
  });

  // Note on the active check: the GitHub provider defaults to checks: ["pkce"]
  // (state is only added under redirectProxyUrl) — verified in @auth/core
  // utils/providers.js. So the CSRF / code-injection protection here is the
  // sealed PKCE code_verifier cookie, not the `state` query param; these tests
  // target that real defense.

  it("rejects a callback missing the PKCE verifier cookie (CSRF defense)", async () => {
    const cookie = await githubSession(USER);
    const jar = new Map<string, string>();
    const authorizeUrl = await beginSignIn(jar, "github");
    const callbackLocation = await githubApprove(cookie, authorizeUrl);

    // An attacker who captured the callback URL has the code but NOT the
    // victim's sealed pkce cookie — replay it from a fresh jar.
    const thiefJar = new Map<string, string>();
    const forged = await GET(
      new Request(callbackLocation, { headers: { cookie: cookieHeader(thiefJar) } }),
    );
    absorb(thiefJar, forged);
    expect(
      forged.headers.get("location") ?? "",
      "must redirect to an error, not /workspaces",
    ).toContain("error");

    const sessionRes = await GET(
      new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: cookieHeader(thiefJar) } }),
    );
    const session: unknown = await sessionRes.json();
    expect(sessionSchema.safeParse(session).success, "no session without the PKCE verifier").toBe(
      false,
    );
  });

  it("rejects a REPLAYED callback — a consumed authorization code is single-use", async () => {
    const cookie = await githubSession(USER);
    const jar = new Map<string, string>();
    const authorizeUrl = await beginSignIn(jar, "github");
    const callbackLocation = await githubApprove(cookie, authorizeUrl);

    // First use succeeds and consumes the code at the IdP.
    const first = await GET(
      new Request(callbackLocation, { headers: { cookie: cookieHeader(jar) } }),
    );
    absorb(jar, first);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${ORIGIN}/workspaces`);

    // Replay the SAME callback with the SAME cookies: PKCE passes, but the IdP
    // must reject the already-redeemed code, so no fresh session is minted.
    const replayJar = new Map(jar);
    const replay = await GET(
      new Request(callbackLocation, { headers: { cookie: cookieHeader(replayJar) } }),
    );
    absorb(replayJar, replay);
    expect(replay.headers.get("location") ?? "").toContain("error");
  });

  it("GitHub: signin → github consent → callback → session carries the team-mapped role", async () => {
    // Provision the admin team so the jwt() callback's team fetch maps admin.
    // Uses admin:org scope (team creation/membership requires it).
    const cookie = await githubSession(USER);
    const provisioningLocation = await githubApprove(
      cookie,
      `${github.url}/login/oauth/authorize?${new URLSearchParams({
        client_id: OAUTH_APP.id,
        redirect_uri: `${ORIGIN}/api/auth/callback/github`,
        scope: "admin:org",
        state: "provision",
      }).toString()}`,
    );
    const provisioningCode = new URL(provisioningLocation).searchParams.get("code");
    if (provisioningCode === null) throw new Error("no provisioning code");
    const token = await githubExchangeCode(provisioningCode, OAUTH_APP.id, OAUTH_APP.secret);
    await githubProvisionTeam(token, ORG, TEAM);

    // The real Auth.js flow.
    const jar = new Map<string, string>();
    const authorizeUrl = await beginSignIn(jar, "github");
    expect(authorizeUrl.startsWith(`${github.url}/login/oauth/authorize`)).toBe(true);

    const callbackLocation = await githubApprove(cookie, authorizeUrl);
    expect(callbackLocation.startsWith(`${ORIGIN}/api/auth/callback/github`)).toBe(true);

    const session = await finishSignIn(jar, callbackLocation);
    // Role mapped from the user's real github team via the jwt() callback.
    expect(session.user.role).toBe("admin");
    expect(session.user.id.length).toBeGreaterThan(0);
  });

  // Auth.js's Entra handler re-discovers the issuer for the id_token's `tid`
  // (real AAD always sets it) WITHOUT oauth4webapi's allowInsecureRequests, so
  // this leg needs the sims over TLS — it runs in the `e2e-https` CI job
  // (EDD_SIM_SCHEME=https + NODE_EXTRA_CA_CERTS), matching real-cloud shape.
  it.runIf(process.env.EDD_SIM_SCHEME === "https")(
    "Entra: signin → azure-sim code → callback validates the id_token and maps the default role",
    async () => {
      const jar = new Map<string, string>();
      const authorizeUrl = await beginSignIn(jar, "microsoft-entra-id");
      expect(authorizeUrl.startsWith(`${entra.endpoint}/${ENTRA_TENANT}`)).toBe(true);

      // The sim issues the code immediately (no interactive page).
      const idpRes = await fetch(authorizeUrl, { redirect: "manual" });
      const callbackLocation = idpRes.headers.get("location");
      if (callbackLocation === null) throw new Error("azure-sim authorize returned no redirect");
      expect(callbackLocation.startsWith(`${ORIGIN}/api/auth/callback/microsoft-entra-id`)).toBe(
        true,
      );

      const session = await finishSignIn(jar, callbackLocation);
      // No login_hint → the sim's default active user, no groups → default role.
      expect(session.user.role).toBe("viewer");
      expect(session.user.id.length).toBeGreaterThan(0);
    },
  );

  it.runIf(process.env.EDD_SIM_SCHEME === "https")(
    "Entra: login_hint selects a Graph-provisioned grouped user → admin role (sockerless#547)",
    async () => {
      // Standard Graph provisioning: a user in a security group.
      const runId = Math.random().toString(36).slice(2, 10);
      const upn = `callback-${runId}@edd-e2e.example.com`;
      const accessToken = await acquireGraphToken(ENTRA_APP.id, ENTRA_APP.secret);
      const { userId, groupId } = await provisionEntraUserWithGroup(accessToken, {
        userPrincipalName: upn,
        password: "Edd-e2e-Passw0rd!",
        displayName: "Callback Admin",
        groupDisplayName: `EDD Callback Admins ${runId}`,
        mailNickname: `callback-${runId}`,
        groupMailNickname: `edd-callback-admins-${runId}`,
      });
      expect(userId.length).toBeGreaterThan(0);
      // The jwt() callback reads the role mapping from env per sign-in.
      process.env[ADMIN_GROUPS_ENV] = `${ORG}/${TEAM},${groupId}`;

      // login_hint (standard OIDC) rides the signin request into the authorize
      // URL; the IdP binds the issued code to that user (real-AAD behaviour).
      const jar = new Map<string, string>();
      const authorizeUrl = await beginSignIn(jar, "microsoft-entra-id", { login_hint: upn });
      expect(new URL(authorizeUrl).searchParams.get("login_hint")).toBe(upn);

      const idpRes = await fetch(authorizeUrl, { redirect: "manual" });
      const callbackLocation = idpRes.headers.get("location");
      if (callbackLocation === null) throw new Error("azure-sim authorize returned no redirect");

      const session = await finishSignIn(jar, callbackLocation);
      // The id_token carried the provisioned user's groups → admin.
      expect(session.user.role).toBe("admin");

      // Unknown login_hint → error redirect (AADSTS50058-style), never a code.
      const badJar = new Map<string, string>();
      const badAuthorize = await beginSignIn(badJar, "microsoft-entra-id", {
        login_hint: `nobody-${runId}@edd-e2e.example.com`,
      });
      const badRes = await fetch(badAuthorize, { redirect: "manual" });
      const badLocation = badRes.headers.get("location") ?? "";
      expect(badLocation).toContain("error=login_required");
      expect(badLocation).not.toContain("code=");
    },
  );
});
