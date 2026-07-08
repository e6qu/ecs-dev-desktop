// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Role } from "@edd/authz";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      role?: Role;
      authSessionId?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: Role;
    authSessionId?: string;
    authSessionVersion?: number;
  }
}
