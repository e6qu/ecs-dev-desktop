// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

import { AdminNav } from "../../components/AdminNav";
import { StateBlock } from "../../components/StateBlock";
import { getPagePrincipal } from "../../lib/principal";
import { TESTID } from "../../lib/testids";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const principal = await getPagePrincipal();
  if (principal?.role !== "admin") {
    return (
      <div data-testid={TESTID.adminDenied}>
        <StateBlock title="Admins only" detail="The admin console requires an administrator." />
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
