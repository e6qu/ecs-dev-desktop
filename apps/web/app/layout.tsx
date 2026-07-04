// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { TopNav } from "../components/TopNav";
import { HelpToggle } from "../components/HelpToggle";
import { getPagePrincipal } from "../lib/principal";
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
          <span className="spacer" />
          <HelpToggle />
          {principal ? (
            <span className="who">
              <span className="mono">{principal.id}</span>
              <span className="badge accent">{principal.role}</span>
              <Link href="/settings/ssh-keys" className="btn">
                ssh keys
              </Link>
              <form action={signOutAction}>
                <button className="btn" type="submit">
                  sign out
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
