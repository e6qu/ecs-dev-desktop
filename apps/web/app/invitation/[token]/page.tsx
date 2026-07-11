// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";

import { field } from "../../../lib/forms";
import { acceptDeveloperInvitation } from "../../../lib/local-accounts";

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function acceptInvitationAction(token: string, formData: FormData): Promise<void> {
  "use server";
  try {
    await acceptDeveloperInvitation({
      token,
      password: field(formData, "password"),
    });
  } catch (error) {
    // Re-render this form with the reason (not found / already accepted / expired)
    // instead of crashing to the generic error page with no route back.
    redirect(
      `/invitation/${encodeURIComponent(token)}?error=${encodeURIComponent(asMessage(error))}`,
    );
  }
  redirect("/login");
}

/** Cap the reflected query-string message (defensive; mirrors admin/invitations). */
function queryValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.slice(0, 500);
}

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const error = queryValue((await searchParams).error);
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
      {error !== undefined && (
        <p className="notice" role="alert" style={{ marginTop: 16 }}>
          accepting the invitation failed: {error}. If this link is used or expired, ask an
          administrator to reissue it.
        </p>
      )}
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
