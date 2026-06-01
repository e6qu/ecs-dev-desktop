// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { Chakra_Petch, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";

import { auth, signOut } from "../auth";
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
  const session = await auth();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="glyph">&gt;</span>
            ecs-dev-desktop
            <small>control plane</small>
          </Link>
          <span className="spacer" />
          {session ? (
            <span className="who">
              <span className="mono">{session.user.id}</span>
              <span className="badge accent">{session.user.role}</span>
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
