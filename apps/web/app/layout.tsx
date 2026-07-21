// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConnectionStatus } from "../components/ConnectionStatus";
import { StartupOverlay } from "../components/StartupOverlay";
import { TopNav } from "../components/TopNav";
import { HelpToggle } from "../components/HelpToggle";
import { PersonaSwitcher } from "../components/PersonaSwitcher";
import { getPagePrincipal } from "../lib/principal";
import { resetCookiesAction } from "./actions";
import { signOutAction } from "./login/actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "ecs-dev-desktop — control plane",
  description: "Cloud dev-environment control plane",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const principal = await getPagePrincipal();

  return (
    <html lang="en">
      <body>
        <StartupOverlay />
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="glyph" aria-hidden="true">
              &gt;
            </span>
            ecs-dev-desktop
            <small>control plane</small>
          </Link>
          {principal && <TopNav isAdmin={principal.role === "admin"} />}
          <ConnectionStatus />
          <span className="spacer" />
          <HelpToggle />
          {principal ? (
            <span className="who" data-shauth-user={principal.displayName ?? principal.id}>
              {/* The display identity doubles as the /me link; its accessible name is
                  distinct ("account: <name>") so it can never collide with a nav
                  link whose label equals a username (e.g. the admin user vs the
                  /admin nav — a locator/screen-reader ambiguity found in CI). */}
              <Link
                href="/me"
                className="account-link"
                aria-label={`account: ${principal.displayName ?? principal.id}`}
              >
                {principal.image !== undefined && (
                  <span
                    className="account-avatar"
                    aria-hidden="true"
                    style={{ backgroundImage: `url(${JSON.stringify(principal.image)})` }}
                  />
                )}
                <span className="mono">{principal.displayName ?? principal.id}</span>
              </Link>
              <span className="badge accent">{principal.role}</span>
              <PersonaSwitcher
                role={principal.role}
                realRole={principal.realRole ?? principal.role}
              />
              <form action={resetCookiesAction}>
                <button
                  className="btn"
                  type="submit"
                  title="Delete all of this app's cookies and start over at the login page"
                >
                  reset cookies
                </button>
              </form>
              <Link href="/settings/ssh-keys" className="btn">
                ssh keys
              </Link>
              <form action={signOutAction}>
                <button className="btn" type="submit" data-shauth-sign-out>
                  Sign out
                </button>
              </form>
            </span>
          ) : (
            <Link href="/login" className="btn primary">
              sign in
            </Link>
          )}
        </header>
        <main id="main" tabIndex={-1}>
          <div className="shell">{children}</div>
        </main>
      </body>
    </html>
  );
}
