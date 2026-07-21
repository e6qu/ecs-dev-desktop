// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DEV_ROLE_COOKIE, DEV_USER_COOKIE } from "../../lib/constants";
import { findDevUser } from "../../lib/dev-users";
import { field } from "../../lib/forms";
import { devAuthEnabled } from "../../lib/principal";
import { shauthEndSessionURL, shauthOidcConfig } from "../../lib/shauth";
import { getAuthSessionLogoutContext } from "../../lib/auth-sessions";

// Host-only (no Domain), so the dev cookies are scoped to the exact host the app
// is served from (e.g. edd.localhost) and never leak to other localhost apps.
const DEV_COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/" } as const;
const AUTH_COOKIE_STEMS = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "__Host-authjs.session-token",
  "authjs.csrf-token",
  "__Host-authjs.csrf-token",
  "authjs.callback-url",
  "__Secure-authjs.callback-url",
] as const;

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
  const store = await cookies();
  if (devAuthEnabled()) {
    store.delete(DEV_USER_COOKIE);
    store.delete(DEV_ROLE_COOKIE);
    redirect("/login");
  }
  const shauth = shauthOidcConfig();
  const { auth, signOut } = await import("../../auth");
  const currentSession = await auth();
  const authSessionId = currentSession?.user.authSessionId;
  const logoutContext =
    typeof authSessionId === "string" ? await getAuthSessionLogoutContext(authSessionId) : null;
  await signOut({ redirect: false });
  for (const cookie of store.getAll()) {
    if (
      AUTH_COOKIE_STEMS.some((stem) => cookie.name === stem || cookie.name.startsWith(`${stem}.`))
    ) {
      store.delete(cookie.name);
    }
  }
  if (shauth !== null && logoutContext?.provider === "shauth") {
    redirect(shauthEndSessionURL(shauth, logoutContext.providerIdToken));
  }
  redirect("/login");
}

export async function localAccountSignIn(formData: FormData): Promise<void> {
  if (devAuthEnabled()) redirect("/login");
  const { signIn } = await import("../../auth");
  try {
    await signIn("credentials", {
      email: field(formData, "email"),
      password: field(formData, "password"),
      redirectTo: "/workspaces",
    });
  } catch (error) {
    if (error instanceof Error && "type" in error && error.type === "CredentialsSignin") {
      redirect("/login?error=CredentialsSignin");
    }
    throw error;
  }
}
