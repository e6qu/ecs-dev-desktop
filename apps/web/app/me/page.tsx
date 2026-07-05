// SPDX-License-Identifier: AGPL-3.0-or-later
import { personasFor } from "@edd/authz";
import Link from "next/link";

import { PersonaSwitcher } from "../../components/PersonaSwitcher";
import { StateBlock } from "../../components/StateBlock";
import { getPagePrincipal } from "../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * Standalone account page: who you're signed in as, your real IdP-derived role,
 * and (when eligible) the "view as" persona switcher — the same control as the
 * topbar user menu, so this page works even with JS-driven UI hidden/zoomed out
 * of view, and gives the switcher a permanent, linkable home (`/me`).
 */
export default async function MePage() {
  const principal = await getPagePrincipal();
  if (principal === null) {
    return (
      <StateBlock
        title="Not signed in"
        detail="Sign in to view your account."
        action={{ href: "/login", label: "sign in" }}
      />
    );
  }

  const realRole = principal.realRole ?? principal.role;
  const viewingAs = principal.role !== realRole;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">account</div>
          <h1>{principal.id}</h1>
          <p>
            Signed in as <span className="badge accent">{realRole}</span>
            {viewingAs && (
              <>
                {" "}
                — currently viewing as <span className="badge">{principal.role}</span>
              </>
            )}
            {principal.email !== undefined && <> · {principal.email}</>}
          </p>
        </div>
      </div>
      {personasFor(realRole).length > 1 && (
        <section className="stack" style={{ gap: 10 }}>
          <h2>View as</h2>
          <p className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
            Preview the app at a role at or below your own — never higher. Resets to your real role
            by switching back.
          </p>
          <PersonaSwitcher role={principal.role} realRole={realRole} />
        </section>
      )}
      <section className="stack" style={{ gap: 10 }}>
        <h2>SSH keys</h2>
        <p>
          <Link href="/settings/ssh-keys" className="btn">
            manage SSH keys
          </Link>
        </p>
      </section>
    </>
  );
}
