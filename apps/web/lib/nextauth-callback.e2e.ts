// SPDX-License-Identifier: AGPL-3.0-or-later
// Auth.js CALLBACK-ROUTE e2e: drives the real exported NextAuth handlers (the
// exact functions `/api/auth/[...nextauth]/route.ts` re-exports) through the
// full OAuth/OIDC dance against the live sims — signin → IdP redirect → real
// code issuance over HTTP → callback (token exchange, JWKS/id_token checks) →
// session with the mapped role. The earlier auth e2e prove the IdP protocol
// helpers; this proves the Auth.js route wiring around them.
//
// Endpoint-only (§6.8): AUTH_GITHUB_URL/AUTH_GITHUB_API_URL point the standard
// GHES options at bleephub; AUTH_MICROSOFT_ENTRA_ID_ISSUER points OIDC
// discovery at the Azure sim. No sim-specific code paths.
import { bleephub, entraSim, ENTRA_SIM_TENANT } from "@edd/config";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { ADMIN_GROUPS_ENV, GITHUB_API_URL_ENV, GITHUB_URL_ENV } from "./constants";
import {
  bleephubApprove,
  bleephubExchangeCode,
  bleephubProvisionTeam,
  bleephubSession,
} from "./test-support/bleephub-oauth";

const ORIGIN = "http://localhost:3000";
const USER = "admin";
const ORG = "acme";
const TEAM = "platform-admins";
const OAUTH_APP = { id: "edd", secret: "secret" };
const ENTRA_APP = { id: "edd-e2e-client", secret: "edd-e2e-secret" };

// Provider + role env BEFORE auth.ts is imported (it reads env at module load).
process.env.AUTH_SECRET = "edd-callback-e2e-secret";
process.env.AUTH_TRUST_HOST = "1";
process.env.AUTH_GITHUB_ID = OAUTH_APP.id;
process.env.AUTH_GITHUB_SECRET = OAUTH_APP.secret;
process.env[GITHUB_URL_ENV] = bleephub.url;
process.env[GITHUB_API_URL_ENV] = bleephub.apiUrl;
process.env.AUTH_MICROSOFT_ENTRA_ID_ID = ENTRA_APP.id;
process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = ENTRA_APP.secret;
process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = `${entraSim.authority}/v2.0`;
process.env[ADMIN_GROUPS_ENV] = `${ORG}/${TEAM}`;

const csrfSchema = z.object({ csrfToken: z.string() });
const sessionSchema = z.object({
  user: z.object({ id: z.string(), role: z.enum(["viewer", "member", "admin"]) }),
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

/** csrf → signin: returns the IdP authorize URL Auth.js redirects to. */
async function beginSignIn(jar: Map<string, string>, provider: string): Promise<string> {
  const csrfRes = await GET(new Request(`${ORIGIN}/api/auth/csrf`));
  absorb(jar, csrfRes);
  const { csrfToken } = csrfSchema.parse(await csrfRes.json());

  const signinRes = await POST(
    new Request(`${ORIGIN}/api/auth/signin/${provider}`, {
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
  beforeAll(async () => {
    // Import the real route module AFTER env is in place.
    const route = await import("../app/api/auth/[...nextauth]/route");
    GET = route.GET as Handler;
    POST = route.POST as Handler;
  });

  it("GitHub: signin → bleephub consent → callback → session carries the team-mapped role", async () => {
    // Provision the admin team so the jwt() callback's team fetch maps admin.
    const cookie = await bleephubSession(USER);
    const provisioningLocation = await bleephubApprove(
      cookie,
      `${bleephub.url}/login/oauth/authorize?${new URLSearchParams({
        client_id: OAUTH_APP.id,
        redirect_uri: `${ORIGIN}/api/auth/callback/github`,
        scope: "read:org",
        state: "provision",
      }).toString()}`,
    );
    const provisioningCode = new URL(provisioningLocation).searchParams.get("code");
    if (provisioningCode === null) throw new Error("no provisioning code");
    const token = await bleephubExchangeCode(provisioningCode, OAUTH_APP.id, OAUTH_APP.secret);
    await bleephubProvisionTeam(token, ORG, TEAM);

    // The real Auth.js flow.
    const jar = new Map<string, string>();
    const authorizeUrl = await beginSignIn(jar, "github");
    expect(authorizeUrl.startsWith(`${bleephub.url}/login/oauth/authorize`)).toBe(true);

    const callbackLocation = await bleephubApprove(cookie, authorizeUrl);
    expect(callbackLocation.startsWith(`${ORIGIN}/api/auth/callback/github`)).toBe(true);

    const session = await finishSignIn(jar, callbackLocation);
    // Role mapped from the user's real bleephub team via the jwt() callback.
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
      expect(authorizeUrl.startsWith(`${entraSim.endpoint}/${ENTRA_SIM_TENANT}`)).toBe(true);

      // The sim issues the code immediately (no interactive page).
      const idpRes = await fetch(authorizeUrl, { redirect: "manual" });
      const callbackLocation = idpRes.headers.get("location");
      if (callbackLocation === null) throw new Error("azure-sim authorize returned no redirect");
      expect(callbackLocation.startsWith(`${ORIGIN}/api/auth/callback/microsoft-entra-id`)).toBe(
        true,
      );

      const session = await finishSignIn(jar, callbackLocation);
      // The sim's active user carries no groups → the default role applies.
      // (Selecting a Graph-provisioned user for the interactive flow is a sim
      // fidelity gap — tracked upstream; group→role via callback is proven on
      // the GitHub leg above.)
      expect(session.user.role).toBe("viewer");
      expect(session.user.id.length).toBeGreaterThan(0);
    },
  );
});
