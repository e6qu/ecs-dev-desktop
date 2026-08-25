// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";

import { signOutAction } from "../app/login/actions";

/**
 * Sign out with a DOCUMENT navigation to the destination the action returns.
 * The Shauth end-session URL is cross-origin, and letting the server action
 * `redirect()` there made Next's router try it as an RSC fetch first — CORS
 * blocked it with console errors before the fallback navigation salvaged the
 * flow. The action ends the session (revocation + cookie expiry ride its
 * response); this button then simply goes where it was told.
 */
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
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      {...(contractAttribute ? { "data-shauth-sign-out": true } : {})}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // No catch: a failed sign-out must FAIL, visibly. The action fails
        // loudly on an incomplete sign-out (revocation or cookie expiry), and
        // swallowing that here would leave a signed-in session behind a button
        // that looked like it worked. The rejection surfaces as an unhandled
        // error and the control stays disabled -- a dead button is the honest
        // representation of a sign-out that did not happen.
        void signOutAction().then(({ redirectTo }) => {
          window.location.assign(redirectTo);
        });
      }}
    >
      Sign out
    </button>
  );
}
