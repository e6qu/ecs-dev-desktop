// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import type { Role } from "@edd/authz";
import { ownerId } from "@edd/core";
import NextAuth from "next-auth";
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
import { errorField, log } from "./lib/logger";

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
    async jwt({ token, account, profile }) {
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
        // server-side keyed by the user id; never exposed to the browser. Sign-in
        // must not fail if storage is unavailable.
        if (
          account.provider === "github" &&
          typeof account.access_token === "string" &&
          account.access_token.length > 0 &&
          gitCredentialsEnabled()
        ) {
          try {
            await getGitCredentials().store(ownerId(claims.subject), account.access_token);
          } catch (err) {
            log.error("failed to store git credential at sign-in", { error: errorField(err) });
          }
        }
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
      // `Session.user.role` is non-optional, so ALWAYS set a concrete value. A JWT
      // lacking a valid role defaults to the LEAST-privileged `viewer` (CASL grants
      // read-only) — explicit least-privilege, never an accidental `undefined` that
      // would make the non-optional type a lie.
      session.user.role =
        role === "viewer" || role === "member" || role === "admin" ? role : "viewer";
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
