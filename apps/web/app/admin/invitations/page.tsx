// SPDX-License-Identifier: AGPL-3.0-or-later
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { StateBlock } from "../../../components/StateBlock";
import { createDeveloperInvitation, listInvitations } from "../../../lib/local-accounts";
import {
  assertInvitationMailerConfigured,
  sendInvitationEmail,
} from "../../../lib/invitation-mailer";
import { field } from "../../../lib/forms";
import { getPagePrincipal } from "../../../lib/principal";

export const dynamic = "force-dynamic";

function adminOnly(principal: Awaited<ReturnType<typeof getPagePrincipal>>) {
  if (principal?.role !== "admin") throw new Error("admin required");
  return principal;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function redirectWithStatus(kind: "error" | "sent", message?: string): never {
  const params = new URLSearchParams();
  params.set(kind, message ?? "1");
  redirect(`/admin/invitations?${params.toString()}`);
}

async function inviteDeveloperAction(formData: FormData): Promise<void> {
  "use server";
  try {
    const principal = adminOnly(await getPagePrincipal());
    assertInvitationMailerConfigured();
    const durationDays = Number(field(formData, "durationDays"));
    const { token, invitation } = await createDeveloperInvitation({
      email: field(formData, "email"),
      durationDays,
      createdBy: principal.id,
    });
    await sendInvitationEmail({ email: invitation.email, token });
    revalidatePath("/admin/invitations");
  } catch (error) {
    redirectWithStatus("error", `invitation email failed: ${asMessage(error)}`);
  }
  redirectWithStatus("sent");
}

async function reissueInvitationAction(formData: FormData): Promise<void> {
  "use server";
  try {
    const principal = adminOnly(await getPagePrincipal());
    assertInvitationMailerConfigured();
    const durationDays = Number(field(formData, "durationDays"));
    const { token, invitation } = await createDeveloperInvitation({
      email: field(formData, "email"),
      durationDays,
      createdBy: principal.id,
    });
    await sendInvitationEmail({ email: invitation.email, token });
    revalidatePath("/admin/invitations");
  } catch (error) {
    redirectWithStatus("error", `invitation email failed: ${asMessage(error)}`);
  }
  redirectWithStatus("sent");
}

function fmt(value: string): string {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function queryValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.slice(0, 500);
}

export default async function AdminInvitationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const principal = await getPagePrincipal();
  if (principal?.role !== "admin") {
    return (
      <StateBlock title="Admins only" detail="Invitation management requires an administrator." />
    );
  }
  const invitations = await listInvitations();
  const params = await searchParams;
  const error = queryValue(params.error);
  const sent = queryValue(params.sent);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">admin</div>
          <h1>Invitations</h1>
          <p>
            Email one-time developer links. Reissuing creates a new token for the same random local
            user id, so accepted links keep access to that user&apos;s existing workspaces.
          </p>
        </div>
      </div>

      {error !== undefined && <StateBlock title="Invitation failed" detail={error} />}
      {sent !== undefined && (
        <StateBlock title="Invitation sent" detail="The one-time developer link was emailed." />
      )}

      <form className="panel field-stack" action={inviteDeveloperAction}>
        <h2>Invite developer</h2>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">email</span>
            <input className="input" name="email" type="email" required />
          </label>
          <label className="field">
            <span className="field-label">duration</span>
            <select className="input" name="durationDays" defaultValue="1">
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
        </div>
        <p className="field-hint">
          Missing SES sender config fails loudly. Invitation duration is configurable from 1 to 30
          days.
        </p>
        <button className="btn primary" type="submit">
          send invitation
        </button>
      </form>

      <h2 style={{ fontSize: 16, margin: "18px 0 10px" }}>Issued links</h2>
      <div className="adm-rows">
        {invitations.map((i) => (
          <div key={`${i.email}-${i.createdAt}`} className="adm-row">
            <span className="wid">{i.email}</span>
            <span className="detail">{i.acceptedAt === undefined ? "pending" : "accepted"}</span>
            <form action={reissueInvitationAction} className="field-stack" style={{ gap: 8 }}>
              <input type="hidden" name="email" value={i.email} />
              <select className="input" name="durationDays" defaultValue="1" aria-label="duration">
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </select>
              <button className="btn" type="submit">
                reissue
              </button>
            </form>
            <div className="meta">
              <span>id {i.ownerId}</span>
              <span>role {i.role}</span>
              <span>expires {fmt(i.expiresAt)}</span>
              <span>created by {i.createdBy}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
