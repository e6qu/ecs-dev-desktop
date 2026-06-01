// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapClaimsToRole } from "@edd/auth";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

import { roleMappingConfig } from "./lib/auth-config";
import { normalizeClaims } from "./lib/claims";

/**
 * Auth.js (NextAuth v5) — GitHub OAuth + Azure Entra ID, JWT sessions. Provider
 * credentials are read from env (AUTH_GITHUB_*, AUTH_MICROSOFT_ENTRA_ID_*,
 * AUTH_SECRET). The role is derived from IdP groups via `@edd/auth` at sign-in
 * and carried in the JWT/session.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub, MicrosoftEntraID],
  session: { strategy: "jwt" },
  callbacks: {
    jwt({ token, account, profile }) {
      if (account && profile) {
        const claims = normalizeClaims(account.provider, profile);
        token.uid = claims.subject;
        token.role = mapClaimsToRole(claims, roleMappingConfig());
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
