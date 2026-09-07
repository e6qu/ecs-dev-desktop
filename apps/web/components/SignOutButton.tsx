// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { markSigningOut } from "../lib/shauth-auto-sign-in";

/**
 * Sign out with a plain HTML form POST to the /auth/sign-out route handler —
 * a DOCUMENT request whose 303 the browser follows natively, cross-origin
 * included. Deliberately neither a server action (an action redirect to the
 * cross-origin Shauth end-session URL is attempted as an RSC fetch and
 * CORS-blocked) nor an onClick navigation (which needs hydration; a click
 * landing before hydration was a silent no-op the SSO browser smoke caught).
 * Works with JavaScript disabled, which is the point.
 *
 * The submit handler only marks this tab as signing out (see
 * lib/shauth-auto-sign-in); it never prevents the native POST. Without
 * hydration there is no marker, but there is also no LiveRefresh to race the
 * logout redirect chain, which is the only reason the marker exists.
 */
function rememberSigningOut(): void {
  try {
    markSigningOut(window.sessionStorage, () => new Date().toISOString());
  } catch {
    // Storage unavailable: the native POST proceeds unmarked.
  }
}

export function SignOutButton({
  className = "btn",
  contractAttribute = true,
}: {
  className?: string;
  /** The `data-shauth-sign-out` contract marker. The header's instance carries
   * it; the validation page's duplicate must not, so contract clients matching
   * the marker keep finding exactly one control per page. */
  contractAttribute?: boolean;
}) {
  return (
    <form action="/auth/sign-out" method="post" onSubmit={rememberSigningOut}>
      <button
        className={className}
        type="submit"
        {...(contractAttribute ? { "data-shauth-sign-out": true } : {})}
      >
        Sign out
      </button>
    </form>
  );
}
