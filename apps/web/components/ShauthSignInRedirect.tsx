// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";

import { ShauthSignInLink } from "./ShauthSignInLink";

const SHAUTH_SIGN_IN_PATH = "/login/shauth";

/**
 * One-shot marker: set when this tab auto-enters Shauth, cleared by
 * {@link ShauthAutoSignInReset} once a signed-in page renders. Landing here
 * signed out while it is still set means the previous auto-entry round-trip
 * did not produce a session (session-store failure, abandoned login), so
 * redirecting again would loop the browser forever.
 */
const AUTO_SIGN_IN_MARKER = "edd-shauth-auto-sign-in";

function readAndSetMarker(): boolean {
  try {
    if (window.sessionStorage.getItem(AUTO_SIGN_IN_MARKER) !== null) return true;
    window.sessionStorage.setItem(AUTO_SIGN_IN_MARKER, new Date().toISOString());
    return false;
  } catch {
    // Storage unavailable (privacy mode): retries cannot be bounded, so never
    // auto-redirect — fall back to the explicit sign-in control.
    return true;
  }
}

/** Clears the one-shot marker; mounted only by signed-in pages. */
export function ShauthAutoSignInReset() {
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(AUTO_SIGN_IN_MARKER);
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }, []);
  return null;
}

/**
 * Enter Shauth with a document navigation. An App Router fetch must never follow
 * the route handler's cross-origin OpenID Connect redirect because browsers
 * correctly reject that response as CORS instead of treating it as navigation.
 *
 * Auto-entry is one-shot per tab: a signed-out landing while the marker is
 * still set renders the explicit sign-in surface instead of redirecting again.
 */
export function ShauthSignInRedirect() {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (readAndSetMarker()) {
      setHeld(true);
      return;
    }
    window.location.replace(SHAUTH_SIGN_IN_PATH);
  }, []);

  if (held) {
    return (
      <div className="empty" role="status" aria-live="polite">
        <h2 className="big">Sign in required</h2>
        <p>Automatic sign-in did not complete a session. Continue to Shauth to sign in.</p>
        <p style={{ marginTop: 18 }}>
          <ShauthSignInLink />
        </p>
      </div>
    );
  }

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
