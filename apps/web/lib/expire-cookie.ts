// SPDX-License-Identifier: AGPL-3.0-or-later

/** The cookie-store surface {@link expireCookie} needs — `next/headers`'
 * `cookies()` satisfies it structurally, and tests pass a recorder. */
export interface ExpirableCookieStore {
  set(options: {
    name: string;
    value: string;
    path: string;
    expires: Date;
    secure?: boolean;
  }): unknown;
}

/**
 * Expire a cookie with attributes the browser will actually accept.
 *
 * A `Set-Cookie` for a `__Secure-` or `__Host-` prefixed name is REJECTED by
 * the browser unless it carries the `Secure` attribute (`__Host-` additionally
 * requires `Path=/` and no `Domain`) — deletions included. Next's
 * `cookies().delete(name)` emits neither, so "deleting"
 * `__Secure-authjs.session-token` on sign-out silently did nothing: the
 * deletion header was discarded, the session cookie survived, and
 * `/api/auth/session` kept authenticating a user who had just signed out.
 * Measured on the deployed app — the sign-out response carried
 * `__Secure-authjs.session-token=; Path=/; Expires=…` with no `Secure`, and
 * the cookie jar afterwards still held all three auth cookies.
 */
export function expireCookie(store: ExpirableCookieStore, name: string): void {
  store.set({
    name,
    value: "",
    path: "/",
    expires: new Date(0),
    ...(name.startsWith("__Secure-") || name.startsWith("__Host-") ? { secure: true } : {}),
  });
}
