// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DEV_ROLE_COOKIE, DEV_USER_COOKIE } from "../../lib/constants";
import { findDevUser } from "../../lib/dev-users";
import { field } from "../../lib/forms";
import { expireCookie } from "../../lib/expire-cookie";
import { devAuthEnabled } from "../../lib/principal";
import { shauthEndSessionURL, shauthOidcConfig } from "../../lib/shauth";
import { getAuthSessionLogoutContext, revokeAuthSession } from "../../lib/auth-sessions";

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
/**
 * End the session and say where the browser should go next.
 *
 * The action RETURNS the destination instead of `redirect()`ing to it: the
 * Shauth end-session URL is CROSS-ORIGIN, and an action redirect to another
 * origin makes Next's router attempt it as an RSC fetch first -- which CORS
 * blocks (visible as "blocked by CORS policy" + `net::ERR_FAILED` console
 * errors with an `_rsc=` query) before the router falls back to a document
 * navigation. The sign-out still worked, but every sign-out risked a burst of
 * browser errors. The client button performs a plain `window.location`
 * navigation with the returned URL, which follows cross-origin redirects the
 * way logout flows expect.
 */
export async function signOutAction(): Promise<{ redirectTo: string }> {
  const store = await cookies();
  if (devAuthEnabled()) {
    store.delete(DEV_USER_COOKIE);
    store.delete(DEV_ROLE_COOKIE);
    return { redirectTo: "/login" };
  }
  const shauth = shauthOidcConfig();
  const { auth, signOut } = await import("../../auth");
  const currentSession = await auth();
  const authSessionId = currentSession?.user.authSessionId;
  const logoutContext =
    typeof authSessionId === "string" ? await getAuthSessionLogoutContext(authSessionId) : null;
  // Revoke the server-side record HERE, synchronously: the JWT cookie stays
  // cryptographically valid until it expires, so without this the only thing
  // ending the session server-side was Shauth's asynchronous back-channel
  // logout -- and a replayed pre-logout cookie kept authenticating until it
  // arrived. Fail-loud on a store error: an incomplete sign-out must not
  // pretend to have signed out.
  if (typeof authSessionId === "string") await revokeAuthSession(authSessionId);
  await signOut({ redirect: false });
  for (const cookie of store.getAll()) {
    if (
      AUTH_COOKIE_STEMS.some((stem) => cookie.name === stem || cookie.name.startsWith(`${stem}.`))
    ) {
      // Attribute-correct expiry, not store.delete: a deletion for a
      // __Secure-/__Host- cookie without the Secure attribute is rejected by
      // the browser, which left the session cookie alive after sign-out.
      expireCookie(store, cookie.name);
    }
  }
  if (shauth !== null && logoutContext?.provider === "shauth") {
    return { redirectTo: shauthEndSessionURL(shauth, logoutContext.providerIdToken) };
  }
  return { redirectTo: "/login" };
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
