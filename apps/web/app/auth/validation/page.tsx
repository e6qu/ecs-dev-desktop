// SPDX-License-Identifier: AGPL-3.0-or-later
import { applicationReleaseRevision } from "@edd/config";
import { redirect } from "next/navigation";

import { getPagePrincipal } from "../../../lib/principal";
import { signOutAction } from "../../login/actions";

export const dynamic = "force-dynamic";

/** Stable, app-owned acceptance surface for deployment-neutral SSO checks. */
export default async function AuthenticationValidationPage() {
  const principal = await getPagePrincipal();
  if (principal === null) redirect("/signed-out");

  const role = principal.realRole ?? principal.role;
  const releaseRevision = applicationReleaseRevision();

  return (
    <section
      className="panel stack"
      aria-labelledby="authentication-validation-heading"
      data-auth-state="authenticated"
      data-release-revision={releaseRevision}
      style={{ maxWidth: 620, margin: "56px auto", gap: 18 }}
    >
      <div>
        <div className="kicker">authentication validation</div>
        <h1 id="authentication-validation-heading">ECS Dev Desktop is authenticated</h1>
        <p style={{ color: "var(--dim)" }}>
          This first-party page reports the signed-in identity and deployed application release.
        </p>
      </div>
      <dl className="identity-grid">
        <dt>Username</dt>
        <dd data-testid="validation-username">{principal.displayName ?? principal.id}</dd>
        <dt>Email</dt>
        <dd data-testid="validation-email">{principal.email ?? "Unavailable"}</dd>
        <dt>Role</dt>
        <dd data-testid="validation-role">{role}</dd>
        <dt>Release</dt>
        <dd className="mono" data-testid="validation-release">
          {releaseRevision}
        </dd>
      </dl>
      <form action={signOutAction}>
        <button className="btn primary" type="submit">
          Sign out
        </button>
      </form>
    </section>
  );
}
