// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sign out with a plain HTML form POST to the /auth/sign-out route handler —
 * a DOCUMENT request whose 303 the browser follows natively, cross-origin
 * included. Deliberately neither a server action (an action redirect to the
 * cross-origin Shauth end-session URL is attempted as an RSC fetch and
 * CORS-blocked) nor an onClick navigation (which needs hydration; a click
 * landing before hydration was a silent no-op the SSO browser smoke caught).
 * Works with JavaScript disabled, which is the point.
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
  return (
    <form action="/auth/sign-out" method="post">
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
