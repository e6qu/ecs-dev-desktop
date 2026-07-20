// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

const SHAUTH_SIGN_IN_PATH = "/login/shauth";

/**
 * App-owned entry into Shauth. Keeping the browser on a same-origin link until
 * the Route Handler starts OpenID Connect avoids React Server Component and
 * Server Action fetches following a cross-origin authorization redirect.
 */
export function ShauthSignInLink({ children = "Sign in with Shauth" }: { children?: ReactNode }) {
  return (
    <a className="btn shauth-button" href={SHAUTH_SIGN_IN_PATH}>
      <span className="shauth-mark" aria-hidden="true">
        S
      </span>
      <span>{children}</span>
    </a>
  );
}
