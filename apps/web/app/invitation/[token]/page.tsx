// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

import { field } from "../../../lib/forms";
import { acceptDeveloperInvitation } from "../../../lib/local-accounts";

async function acceptInvitationAction(token: string, formData: FormData): Promise<void> {
  "use server";
  await acceptDeveloperInvitation({
    token,
    password: field(formData, "password"),
  });
  redirect("/login");
}

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const action = acceptInvitationAction.bind(null, token);
  return (
    <div className="panel" style={{ maxWidth: 440, margin: "56px auto" }}>
      <div
        className="mono"
        style={{ color: "var(--accent)", letterSpacing: "0.2em", fontSize: 11 }}
      >
        INVITATION
      </div>
      <h1 style={{ fontSize: 26, marginTop: 10 }}>Create your password</h1>
      <p style={{ color: "var(--dim)", marginTop: 8 }}>
        This developer invitation creates or refreshes your EDD account.
      </p>
      <form action={action} className="field-stack" style={{ marginTop: 24 }}>
        <label className="field">
          <span className="field-label">password</span>
          <input
            className="input"
            name="password"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
          />
        </label>
        <button className="btn primary" type="submit">
          accept invitation
        </button>
      </form>
    </div>
  );
}
