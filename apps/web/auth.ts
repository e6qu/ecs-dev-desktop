// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import { isRole } from "@edd/authz";
import { ownerId } from "@edd/core";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { decodeJwt } from "jose";

import { roleMappingConfig } from "./lib/auth-config";
import {
  AUTH_SESSION_SCHEMA_VERSION,
  createAuthSession,
  revokeAuthSession,
  validateAuthSessionToken,
} from "./lib/auth-sessions";
import type { ValidAuthSession } from "./lib/auth-sessions";
import { normalizeClaims } from "./lib/claims";
import { GITHUB_URL_ENV } from "./lib/constants";
import { getGitCredentials, gitCredentialsEnabled } from "./lib/git-credentials";
import { fetchGithubTeamGroups } from "./lib/github-teams";
import { entraOAuthClient, githubOAuthClient } from "./lib/identity-providers";
import { authenticateLocalAccount } from "./lib/local-accounts";
import { shauthEnabled, shauthProvider } from "./lib/shauth";

/**
 * Auth.js (NextAuth v5) — GitHub OAuth, Microsoft Entra ID, and Shauth OpenID
 * Connect, with signed cookies
 * backed by an EDD server-side session record. Provider
 * credentials are read from env (AUTH_GITHUB_*, AUTH_MICROSOFT_ENTRA_ID_*,
 * AUTH_SECRET). The role is derived from IdP groups via `@edd/auth` at sign-in
 * and carried in the JWT/session. GitHub teams aren't in the OAuth profile, so
 * they're fetched from `/user/teams` (the `read:org` scope below) at sign-in.
 *
 * AUTH_GITHUB_URL (GitHub Enterprise web base — or the github sim) switches
 * the OAuth endpoints via the provider's standard `enterprise` option; unset
 * means github.com. Endpoint-only, never a behavioural branch (§6.8).
 */
const githubEnterpriseUrl = process.env[GITHUB_URL_ENV];
const configuredShauthProvider = shauthProvider();
const configuredGitHubClient = githubOAuthClient();
const configuredEntraClient = entraOAuthClient();

/**
 * Look up the server-side session record, keeping store FAILURE distinct from
 * NO SESSION. `null` means the store answered and the session is genuinely
 * absent/expired/revoked — the caller strips the principal. A store failure
 * (DynamoDB unreachable, IAM, throttle) rethrows so it surfaces as a
 * JWTSessionError instead of being laundered into a silent sign-out.
 */
async function requireAuthSessionStore(
  token: Parameters<typeof validateAuthSessionToken>[0],
): Promise<ValidAuthSession | null> {
  try {
    return await validateAuthSessionToken(token);
  } catch (cause) {
    throw new Error("auth session store lookup failed; refusing to treat as signed out", {
      cause,
    });
  }
}

/** Session lifetime: 4 hours, rolling (see the `session` block below). */
const SESSION_MAX_AGE_S = 4 * 60 * 60;
/** Re-issue (roll) the session cookie when used more than 30 min after its last issue. */
const SESSION_UPDATE_AGE_S = 30 * 60;

// Shauth is the deployment's identity provider when it is configured: it has
// already authenticated the person against GitHub, Entra, or a local Shauth
// account. Offering this application's own password form as well would ask the
// same person to authenticate twice, and would leave a second credential path
// into an application that is supposed to have exactly one.
const localAccountsEnabled = !shauthEnabled();

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    ...(!localAccountsEnabled
      ? []
      : [
          Credentials({
            credentials: {
              email: { label: "Email", type: "email" },
              password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
              const email = typeof credentials.email === "string" ? credentials.email : "";
              const password = typeof credentials.password === "string" ? credentials.password : "";
              const account = await authenticateLocalAccount(email, password);
              if (account === null) return null;
              return {
                id: account.ownerId,
                email: account.email,
                name: account.email,
                role: account.role,
              };
            },
          }),
        ]),
    ...(configuredGitHubClient === null
      ? []
      : [
          GitHub({
            ...configuredGitHubClient,
            ...(githubEnterpriseUrl !== undefined && githubEnterpriseUrl.length > 0
              ? { enterprise: { baseUrl: githubEnterpriseUrl } }
              : {}),
            authorization: { params: { scope: "read:user user:email read:org repo" } },
            // GitHub's token endpoint takes the client credentials in the form
            // body. Without this the OAuth client falls back to HTTP Basic and
            // the exchange comes back as an error document, which surfaces as
            // Auth.js failing to find `access_token` in the response — the same
            // reason the Entra provider below pins its method.
            client: { token_endpoint_auth_method: "client_secret_post" },
          }),
        ]),
    ...(configuredEntraClient === null
      ? []
      : [
          MicrosoftEntraID({
            ...configuredEntraClient,
            // The stock profile() fetches a photo from Microsoft Graph. EDD
            // does not consume it, so identity stays entirely in ID-token claims.
            profile: (profile) => ({
              id: profile.sub,
              name: profile.name,
              email: profile.email,
              image: null,
            }),
            client: { token_endpoint_auth_method: "client_secret_post" },
          }),
        ]),
    ...(configuredShauthProvider === null ? [] : [configuredShauthProvider]),
  ],
  // 4-hour sessions with a rolling refresh plus a REQUIRED server-side session
  // record. The cookie alone never authorizes: every request must carry the
  // current schema marker + authSessionId, and that row must still be active in
  // DynamoDB. This gives logout/revocation server-side control over unexpired
  // signed cookies. Old-format cookies fail closed and force a fresh login.
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_S, updateAge: SESSION_UPDATE_AGE_S },
  // A sign-in that fails server-side otherwise ends on Auth.js's built-in page,
  // which in this deployment rendered as an unexplained 200 carrying no reason
  // at all -- the whole diagnosis of #257 was blocked on that. Route failures to
  // a page that names the error Auth.js reports.
  pages: { error: "/auth/error" },
  // @auth/core catches every callback throw (JWTSessionError) and answers the
  // request as signed out; without a logger that evidence never reaches the
  // task's console output. Log the full error chain so a session-store outage
  // is diagnosable from the deployed logs.
  logger: {
    error(error) {
      console.error("[auth]", error);
    },
  },
  callbacks: {
    async jwt({ token, account, profile, user }) {
      if (account && profile) {
        const claims = normalizeClaims(account.provider, profile);
        const groups =
          account.provider === "github" && typeof account.access_token === "string"
            ? await fetchGithubTeamGroups({ accessToken: account.access_token })
            : claims.groups;
        const role = mapClaimsToRole({ ...claims, groups }, roleMappingConfig());
        token.uid = claims.subject;
        token.role = role;
        let providerSessionId: string | undefined;
        let providerIdToken: string | undefined;
        if (account.provider === "shauth") {
          if (typeof account.id_token !== "string" || account.id_token.length === 0) {
            throw new Error("Shauth did not return an ID token");
          }
          const sid = decodeJwt(account.id_token).sid;
          if (typeof sid !== "string" || sid.length === 0) {
            throw new Error("Shauth ID token did not identify its provider session");
          }
          providerSessionId = sid;
          providerIdToken = account.id_token;
        }
        const authSession = await createAuthSession({
          ownerId: claims.subject,
          role,
          provider: account.provider,
          providerSubject: claims.subject,
          ...(providerSessionId === undefined ? {} : { providerSessionId }),
          ...(providerIdToken === undefined ? {} : { providerIdToken }),
        });
        token.authSessionId = authSession.id;
        token.authSessionVersion = AUTH_SESSION_SCHEMA_VERSION;
        // Capture the GitHub token (encrypted at rest) so a session can later
        // clone/push private repos via the boot-time credential broker. Stored
        // server-side keyed by the user id; never exposed to the browser. If the
        // broker is enabled, storing the token is part of sign-in and must fail
        // loudly on write errors.
        if (
          account.provider === "github" &&
          typeof account.access_token === "string" &&
          account.access_token.length > 0 &&
          gitCredentialsEnabled()
        ) {
          await getGitCredentials().store(ownerId(claims.subject), account.access_token);
        }
      } else if (account?.provider === "credentials") {
        const role = "role" in user ? user.role : undefined;
        if (role !== "developer" && role !== "admin")
          throw new Error("local account has invalid role");
        if (typeof user.email !== "string" || user.email.length === 0) {
          throw new Error("local account has no email");
        }
        if (typeof user.id !== "string" || user.id.length === 0) {
          throw new Error("local account has no owner id");
        }
        token.uid = user.id;
        token.email = user.email;
        token.role = role;
        const authSession = await createAuthSession({ ownerId: user.id, role });
        token.authSessionId = authSession.id;
        token.authSessionVersion = AUTH_SESSION_SCHEMA_VERSION;
      } else {
        const authSession = await requireAuthSessionStore(token);
        if (authSession === null) {
          delete token.uid;
          delete token.role;
          delete token.authSessionId;
          delete token.authSessionVersion;
        }
      }
      return token;
    },
    async session({ session, token }) {
      const authSession = await requireAuthSessionStore(token);
      if (authSession === null) {
        // No valid server-side record means NO session -- not an anonymous
        // husk. Stripping only id/role used to leave a `user` object still
        // carrying name/email/image, so a replayed post-logout cookie (or a
        // revoked session) answered /api/auth/session with an identity. The
        // signed-out contract is that `user` is ABSENT.
        delete (session as { user?: unknown }).user;
        return session;
      }
      const { uid, role } = token;
      if (typeof uid === "string") session.user.id = uid;
      if (typeof token.email === "string") session.user.email = token.email;
      if (typeof role !== "string" || !isRole(role)) {
        throw new Error("validated auth session carried an invalid role");
      }
      session.user.role = role;
      session.user.authSessionId = authSession.id;
      return session;
    },
  },
  events: {
    async signOut(message) {
      if (
        "token" in message &&
        message.token !== null &&
        typeof message.token.authSessionId === "string"
      ) {
        await revokeAuthSession(message.token.authSessionId);
      }
    },
  },
});
