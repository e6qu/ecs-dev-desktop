// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function topNavState(path: string, href: string): string {
  if (href === "/workspaces") {
    return path === "/workspaces" ||
      path.startsWith("/workspaces/") ||
      path.startsWith("/sessions/")
      ? "on"
      : "";
  }
  if (href === "/admin") {
    return path === "/admin" || path.startsWith("/admin/") ? "on" : "";
  }
  return path === href || path.startsWith(`${href}/`) ? "on" : "";
}

export function TopNav({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname();

  return (
    <nav className="tabs top-tabs" aria-label="Primary">
      <Link href="/workspaces" className={topNavState(path, "/workspaces")}>
        workspaces
      </Link>
      {isAdmin && (
        <Link href="/admin" className={topNavState(path, "/admin")}>
          admin
        </Link>
      )}
    </nav>
  );
}
