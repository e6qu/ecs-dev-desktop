// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";

import {
  type AutoSignInDecision,
  clearAutoSignInMarkers,
  decideAutoSignIn,
} from "../lib/shauth-auto-sign-in";
import { ShauthSignInLink } from "./ShauthSignInLink";

const SHAUTH_SIGN_IN_PATH = "/login/shauth";

const isoNow = (): string => new Date().toISOString();

function decide(): AutoSignInDecision {
  try {
    return decideAutoSignIn(window.sessionStorage, isoNow);
  } catch {
    // Storage unavailable (privacy mode): retries cannot be bounded, so never
    // auto-redirect — fall back to the explicit sign-in control.
    return "hold";
  }
}

/**
 * Clears the per-tab markers; mounted by signed-in pages and by the signed-out
 * landing, the two states in which the tab is settled (see lib/shauth-auto-sign-in).
 */
export function ShauthAutoSignInReset() {
  useEffect(() => {
    try {
      clearAutoSignInMarkers(window.sessionStorage);
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
 * A tab that is signing out never auto-enters: the render that sees the session
 * gone is a background refresh of the page that hosted the sign-out button, and
 * a `location.replace` from it would cancel the logout navigation in flight.
 */
export function ShauthSignInRedirect() {
  const [decision, setDecision] = useState<AutoSignInDecision | null>(null);

  useEffect(() => {
    const next = decide();
    setDecision(next);
    if (next === "redirect") window.location.replace(SHAUTH_SIGN_IN_PATH);
  }, []);

  if (decision === "hold") {
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

  if (decision === "signing-out") {
    return (
      <div className="empty" role="status" aria-live="polite">
        <h2 className="big">Signing you out</h2>
        <p>Shauth is ending the shared sign-in session.</p>
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
