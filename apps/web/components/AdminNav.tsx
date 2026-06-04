// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Live sections link out; the rest are placeholders for later Phase 8 sub-phases.
const ITEMS: { label: string; href: string | null }[] = [
  { label: "Overview", href: "/admin/overview" },
  { label: "Health", href: "/admin/health" },
  { label: "Workspaces", href: "/admin/workspaces" },
  { label: "Logs", href: "/admin/logs" },
  { label: "Catalog", href: "/base-images" },
  { label: "Users", href: null },
  { label: "Quotas", href: "/admin/quotas" },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="admin-side">
      <div className="sec">admin</div>
      {ITEMS.map((it) =>
        it.href === null ? (
          <a key={it.label} className="soon" title="coming soon">
            {it.label}
          </a>
        ) : (
          <Link
            key={it.label}
            href={it.href}
            className={path === it.href || path.startsWith(`${it.href}/`) ? "on" : ""}
          >
            {it.label}
          </Link>
        ),
      )}
    </nav>
  );
}
