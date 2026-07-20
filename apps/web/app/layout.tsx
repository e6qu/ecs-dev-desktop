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
            <span className="who">
              {/* The username doubles as the /me link; its ACCESSIBLE name is
                  distinct ("account: <id>") so it can never collide with a nav
                  link whose label equals a username (e.g. the admin user vs the
                  /admin nav — a locator/screen-reader ambiguity found in CI). */}
              <Link href="/me" className="mono" aria-label={`account: ${principal.id}`}>
                {principal.id}
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
                <button className="btn" type="submit">
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
