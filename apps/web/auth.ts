// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import { ownerId } from "@edd/core";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

import { roleMappingConfig } from "./lib/auth-config";
import { normalizeClaims } from "./lib/claims";
import { GITHUB_URL_ENV } from "./lib/constants";
import { getGitCredentials, gitCredentialsEnabled } from "./lib/git-credentials";
import { fetchGithubTeamGroups } from "./lib/github-teams";
import { errorField, log } from "./lib/logger";

/**
 * Auth.js (NextAuth v5) — GitHub OAuth + Azure Entra ID, JWT sessions. Provider
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      ...(githubEnterpriseUrl !== undefined && githubEnterpriseUrl.length > 0
        ? { enterprise: { baseUrl: githubEnterpriseUrl } }
        : {}),
      authorization: { params: { scope: "read:user user:email read:org" } },
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
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        const claims = normalizeClaims(account.provider, profile);
        const groups =
          account.provider === "github" && typeof account.access_token === "string"
            ? await fetchGithubTeamGroups({ accessToken: account.access_token })
            : claims.groups;
        token.uid = claims.subject;
        token.role = mapClaimsToRole({ ...claims, groups }, roleMappingConfig());
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
      }
      return token;
    },
    session({ session, token }) {
      const { uid, role } = token;
      if (typeof uid === "string") session.user.id = uid;
      // `Session.user.role` is non-optional, so ALWAYS set a concrete value. A JWT
      // lacking a valid role defaults to the LEAST-privileged `viewer` (CASL grants
      // read-only) — explicit least-privilege, never an accidental `undefined` that
      // would make the non-optional type a lie.
      session.user.role =
        role === "viewer" || role === "member" || role === "admin" ? role : "viewer";
      return session;
    },
  },
});
