// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin sidebar navigation items.
const ITEMS: { label: string; href: string | null }[] = [
  { label: "Overview", href: "/admin/overview" },
  { label: "Health", href: "/admin/health" },
  { label: "Infrastructure", href: "/admin/infrastructure" },
  { label: "Images", href: "/admin/images" },
  { label: "Workspaces", href: "/admin/workspaces" },
  { label: "Users", href: "/admin/users" },
  { label: "Invitations", href: "/admin/invitations" },
  { label: "Catalog", href: "/admin/catalog" },
  { label: "Costs", href: "/admin/costs" },
  { label: "Logs", href: "/admin/logs" },
  { label: "Quotas", href: "/admin/quotas" },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="admin-side" aria-label="Admin sections">
      <div className="sec">admin</div>
      {ITEMS.map((it) =>
        it.href === null ? (
          <span key={it.label} className="soon" aria-disabled="true">
            {it.label}
          </span>
        ) : (
          <Link
            key={it.label}
            href={it.href}
            aria-current={path === it.href || path.startsWith(`${it.href}/`) ? "page" : undefined}
            className={path === it.href || path.startsWith(`${it.href}/`) ? "on" : ""}
          >
            {it.label}
          </Link>
        ),
      )}
    </nav>
  );
}
