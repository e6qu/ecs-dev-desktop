// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { Chakra_Petch, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";

import { signOut } from "../auth";
import { getPagePrincipal } from "../lib/principal";
import "./globals.css";

const display = Chakra_Petch({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});
const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ecs-dev-desktop — control plane",
  description: "Cloud dev-environment control plane",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const principal = await getPagePrincipal();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="glyph">&gt;</span>
            ecs-dev-desktop
            <small>control plane</small>
          </Link>
          {principal && (
            <nav className="tabs" style={{ marginLeft: 6 }}>
              <Link href="/workspaces">workspaces</Link>
              {principal.role === "admin" && <Link href="/base-images">catalog</Link>}
            </nav>
          )}
          <span className="spacer" />
          {principal ? (
            <span className="who">
              <span className="mono">{principal.id}</span>
              <span className="badge accent">{principal.role}</span>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/login" });
                }}
              >
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
        <main>
          <div className="shell">{children}</div>
        </main>
      </body>
    </html>
  );
}
