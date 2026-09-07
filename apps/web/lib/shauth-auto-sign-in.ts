// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-tab state behind Shauth auto-entry — pure over a Storage-shaped port so the
 * decision is unit-testable without a DOM.
 *
 * Two markers, both in `sessionStorage` (tab-scoped, gone when the tab closes):
 *
 * - {@link AUTO_SIGN_IN_MARKER}: set when this tab auto-enters Shauth, cleared once
 *   a signed-in page renders. Landing signed out while it is still set means the
 *   previous round-trip produced no session, so redirecting again would loop.
 * - {@link SIGNING_OUT_MARKER}: set the moment the user submits sign-out, cleared by
 *   the signed-out landing (and by any signed-in render). While a sign-out is in
 *   flight the session cookie is already gone, but the page that hosted the button
 *   is still mounted and its LiveRefresh keeps re-rendering the route every few
 *   seconds. A refresh that lands inside the logout redirect chain renders the
 *   route signed out; if that render auto-entered Shauth, `location.replace`
 *   would cancel the in-flight logout navigation and bounce the user into a new
 *   sign-in instead of the signed-out landing. The marker turns that render into a
 *   hold.
 */
export const AUTO_SIGN_IN_MARKER = "edd-shauth-auto-sign-in";
export const SIGNING_OUT_MARKER = "edd-shauth-signing-out";

/** The subset of `Storage` these helpers use. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AutoSignInDecision =
  /** Enter Shauth now; the auto-entry marker has been set for this tab. */
  | "redirect"
  /** A previous auto-entry did not produce a session: show the explicit control. */
  | "hold"
  /** This tab is signing out: never start a new sign-in underneath it. */
  | "signing-out";

/**
 * Decide what a signed-out render should do. Sets the auto-entry marker when it
 * decides to redirect, so the next signed-out render in this tab holds instead.
 */
export function decideAutoSignIn(storage: MarkerStorage, now: () => string): AutoSignInDecision {
  if (storage.getItem(SIGNING_OUT_MARKER) !== null) return "signing-out";
  if (storage.getItem(AUTO_SIGN_IN_MARKER) !== null) return "hold";
  storage.setItem(AUTO_SIGN_IN_MARKER, now());
  return "redirect";
}

/** Record that this tab submitted sign-out. */
export function markSigningOut(storage: MarkerStorage, now: () => string): void {
  storage.setItem(SIGNING_OUT_MARKER, now());
}

/** A signed-in render, or the signed-out landing: this tab is in a settled state. */
export function clearAutoSignInMarkers(storage: MarkerStorage): void {
  storage.removeItem(AUTO_SIGN_IN_MARKER);
  storage.removeItem(SIGNING_OUT_MARKER);
}
