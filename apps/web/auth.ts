// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import { isRole, type Role } from "@edd/authz";
import { ownerId } from "@edd/core";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

import { roleMappingConfig } from "./lib/auth-config";
import {
  AUTH_SESSION_SCHEMA_VERSION,
  createAuthSession,
  revokeAuthSession,
  validateAuthSessionToken,
} from "./lib/auth-sessions";
import { normalizeClaims } from "./lib/claims";
import { GITHUB_URL_ENV } from "./lib/constants";
import { getGitCredentials, gitCredentialsEnabled } from "./lib/git-credentials";
import { fetchGithubTeamGroups } from "./lib/github-teams";
import { authenticateLocalAccount } from "./lib/local-accounts";

/**
 * Auth.js (NextAuth v5) — GitHub OAuth + Azure Entra ID, with signed cookies
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

/** Session lifetime: 4 hours, rolling (see the `session` block below). */
const SESSION_MAX_AGE_S = 4 * 60 * 60;
/** Re-issue (roll) the session cookie when used more than 30 min after its last issue. */
const SESSION_UPDATE_AGE_S = 30 * 60;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
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
    GitHub({
      ...(githubEnterpriseUrl !== undefined && githubEnterpriseUrl.length > 0
        ? { enterprise: { baseUrl: githubEnterpriseUrl } }
        : {}),
      authorization: { params: { scope: "read:user user:email read:org repo" } },
    }),
    MicrosoftEntraID({
      // The stock profile() fetches the user's photo from a hardcoded
      // graph.microsoft.com URL on every sign-in. We never consume it (uid and
      // role come from the id_token claims in jwt() below), so skip the call —
      // it would also be the one non-endpoint-configurable cloud request.
      profile: (profile) => ({
        id: profile.sub,
        name: profile.name,
        email: profile.email,
        image: null,
      }),
      // Send client credentials in the token-request body (what MSAL does and
      // what AAD's discovery advertises), not Auth.js's Basic-header default.
      client: { token_endpoint_auth_method: "client_secret_post" },
    }),
  ],
  // 4-hour sessions with a rolling refresh plus a REQUIRED server-side session
  // record. The cookie alone never authorizes: every request must carry the
  // current schema marker + authSessionId, and that row must still be active in
  // DynamoDB. This gives logout/revocation server-side control over unexpired
  // signed cookies. Old-format cookies fail closed and force a fresh login.
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_S, updateAge: SESSION_UPDATE_AGE_S },
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
        const authSession = await createAuthSession({ ownerId: claims.subject, role });
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
        const authSession = await validateAuthSessionToken(token);
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
      const authSession = await validateAuthSessionToken(token);
      if (authSession === null) {
        const user = session.user as { id?: string; role?: Role; authSessionId?: string };
        delete user.id;
        delete user.role;
        delete user.authSessionId;
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
