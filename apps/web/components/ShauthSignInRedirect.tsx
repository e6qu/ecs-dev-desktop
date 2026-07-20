// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect } from "react";

const SHAUTH_SIGN_IN_PATH = "/login/shauth";

/**
 * Enter Shauth with a document navigation. An App Router fetch must never follow
 * the route handler's cross-origin OpenID Connect redirect because browsers
 * correctly reject that response as CORS instead of treating it as navigation.
 */
export function ShauthSignInRedirect() {
  useEffect(() => {
    window.location.replace(SHAUTH_SIGN_IN_PATH);
  }, []);

  return (
    <div className="empty" role="status" aria-live="polite">
      <h2 className="big">Signing you in</h2>
      <p>Connecting to Shauth for single sign-on.</p>
      <p style={{ marginTop: 18 }}>
        <a className="btn primary" href={SHAUTH_SIGN_IN_PATH}>
          Continue to Shauth
        </a>
      </p>
    </div>
  );
}
