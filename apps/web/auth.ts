// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

import { roleMappingConfig } from "./lib/auth-config";
import { normalizeClaims } from "./lib/claims";
import { fetchGithubTeamGroups } from "./lib/github-teams";

/**
 * Auth.js (NextAuth v5) — GitHub OAuth + Azure Entra ID, JWT sessions. Provider
 * credentials are read from env (AUTH_GITHUB_*, AUTH_MICROSOFT_ENTRA_ID_*,
 * AUTH_SECRET). The role is derived from IdP groups via `@edd/auth` at sign-in
 * and carried in the JWT/session. GitHub teams aren't in the OAuth profile, so
 * they're fetched from `/user/teams` (the `read:org` scope below) at sign-in.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({ authorization: { params: { scope: "read:user user:email read:org" } } }),
    MicrosoftEntraID,
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
      }
      return token;
    },
    session({ session, token }) {
      const { uid, role } = token;
      if (typeof uid === "string") session.user.id = uid;
      if (role === "viewer" || role === "member" || role === "admin") {
        session.user.role = role;
      }
      return session;
    },
  },
});
