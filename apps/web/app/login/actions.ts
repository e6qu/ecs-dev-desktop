// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DEV_ROLE_COOKIE, DEV_USER_COOKIE } from "../../lib/constants";
import { findDevUser } from "../../lib/dev-users";
import { devAuthEnabled } from "../../lib/principal";

// Host-only (no Domain), so the dev cookies are scoped to the exact host the app
// is served from (e.g. edd.localhost) and never leak to other localhost apps.
const DEV_COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/" } as const;

/**
 * Local dev sign-in (gated on `EDD_DEV_AUTH=1`): authenticate against the seeded
 * accounts and set the dev principal cookies. On bad credentials, bounce back to
 * the form with an error. Never available in production (Auth.js OIDC there).
 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function devSignIn(formData: FormData): Promise<void> {
  if (!devAuthEnabled()) redirect("/login");
  const user = findDevUser(field(formData, "username"), field(formData, "password"));
  if (user === null) redirect("/login?error=invalid");

  const store = await cookies();
  store.set(DEV_USER_COOKIE, user.username, DEV_COOKIE_OPTS);
  store.set(DEV_ROLE_COOKIE, user.role, DEV_COOKIE_OPTS);
  redirect(user.role === "admin" ? "/admin/overview" : "/workspaces");
}

/**
 * Sign out. In dev-auth mode this clears the dev cookies (Auth.js `signOut` would
 * not — it only knows its own session cookie); otherwise it ends the Auth.js
 * session.
 */
export async function signOutAction(): Promise<void> {
  if (devAuthEnabled()) {
    const store = await cookies();
    store.delete(DEV_USER_COOKIE);
    store.delete(DEV_ROLE_COOKIE);
    redirect("/login");
  }
  const { signOut } = await import("../../auth");
  await signOut({ redirectTo: "/login" });
}
