// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEV_ROLE_COOKIE, DEV_USER_COOKIE } from "./constants";
import { getAuthSessionLogoutContext, revokeAuthSession } from "./auth-sessions";
import { expireCookie } from "./expire-cookie";
import { devAuthEnabled } from "./principal";
import { shauthEndSessionURL, shauthOidcConfig } from "./shauth";

/** The cookie stems sign-out must expire — Auth.js session/CSRF/callback in
 * every prefix variant, chunked (`.0`, `.1`, …) included. */
const AUTH_COOKIE_STEMS = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "__Host-authjs.session-token",
  "authjs.csrf-token",
  "__Host-authjs.csrf-token",
  "authjs.callback-url",
  "__Secure-authjs.callback-url",
] as const;

/** The cookie-store surface {@link performSignOut} needs — `next/headers`'
 * `cookies()` satisfies it structurally, and tests pass a recorder. */
export interface SignOutCookieStore {
  getAll(): { name: string }[];
  delete(name: string): unknown;
  set(options: {
    name: string;
    value: string;
    path: string;
    expires: Date;
    secure?: boolean;
  }): unknown;
}

/**
 * End the session and say where the browser should go next.
 *
 * Called from the POST /auth/sign-out route handler, which a plain HTML form
 * submits as a DOCUMENT request — deliberately not a server action. An action
 * `redirect()` to the CROSS-ORIGIN Shauth end-session URL is attempted as an
 * RSC fetch first and blocked by CORS; an onClick handler that navigates after
 * the action needs hydration, and a click that lands before hydration is a
 * silent no-op (the SSO browser smoke caught exactly that). A native form
 * POST → 303 works before hydration, without JavaScript, and follows
 * cross-origin logout redirects the way OIDC RP-Initiated Logout expects.
 */
export async function performSignOut(store: SignOutCookieStore): Promise<{ redirectTo: string }> {
  if (devAuthEnabled()) {
    store.delete(DEV_USER_COOKIE);
    store.delete(DEV_ROLE_COOKIE);
    return { redirectTo: "/login" };
  }
  const shauth = shauthOidcConfig();
  const { auth, signOut } = await import("../auth");
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
