// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

import { AdminNav } from "../../components/AdminNav";
import { getPagePrincipal } from "../../lib/principal";
import { TESTID } from "../../lib/testids";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const principal = await getPagePrincipal();
  if (principal?.role !== "admin") {
    return (
      <div className="empty" data-testid={TESTID.adminDenied}>
        <div className="big">Admins only</div>
        <p>The admin console requires an administrator.</p>
      </div>
    );
  }
  return (
    <div className="admin-shell">
      <AdminNav />
      <div>{children}</div>
    </div>
  );
}
