// SPDX-License-Identifier: AGPL-3.0-or-later
import { revalidatePath } from "next/cache";

import {
  createLocalAccount,
  listAuthSessions,
  listLocalAccounts,
  revokeAllSessions,
  revokeUserSessions,
} from "../../../lib/local-accounts";
import { field } from "../../../lib/forms";
import { getPagePrincipal } from "../../../lib/principal";
import { StateBlock } from "../../../components/StateBlock";

export const dynamic = "force-dynamic";

function adminOnly(principal: Awaited<ReturnType<typeof getPagePrincipal>>) {
  if (principal?.role !== "admin") throw new Error("admin required");
  return principal;
}

async function createAdminAccountAction(formData: FormData): Promise<void> {
  "use server";
  const principal = adminOnly(await getPagePrincipal());
  const role = field(formData, "role");
  if (role !== "admin" && role !== "developer") throw new Error("invalid local-account role");
  await createLocalAccount({
    email: field(formData, "email"),
    password: field(formData, "password"),
    role,
    createdBy: principal.id,
  });
  revalidatePath("/admin/users");
}

async function revokeUserSessionsAction(formData: FormData): Promise<void> {
  "use server";
  adminOnly(await getPagePrincipal());
  await revokeUserSessions(field(formData, "ownerId"));
  revalidatePath("/admin/users");
}

async function revokeAllSessionsAction(): Promise<void> {
  "use server";
  adminOnly(await getPagePrincipal());
  await revokeAllSessions();
  revalidatePath("/admin/users");
}

function fmt(value: string): string {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function AdminUsersPage() {
  const principal = await getPagePrincipal();
  if (principal?.role !== "admin") {
    return <StateBlock title="Admins only" detail="The user console requires an administrator." />;
  }
  const [accounts, sessions] = await Promise.all([listLocalAccounts(), listAuthSessions()]);
  const activeSessions = sessions.filter((s) => s.revokedAt === undefined);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">admin</div>
          <h1>Users</h1>
          <p>Create local accounts and revoke server-side login sessions.</p>
        </div>
        <form action={revokeAllSessionsAction}>
          <button className="btn danger" type="submit">
            revoke all sessions
          </button>
        </form>
      </div>

      <div className="form-grid">
        <form className="panel field-stack field-span-2" action={createAdminAccountAction}>
          <h2>Create account</h2>
          <label className="field">
            <span className="field-label">email</span>
            <input className="input" name="email" type="email" required />
          </label>
          <label className="field">
            <span className="field-label">role</span>
            <select className="input" name="role" defaultValue="admin">
              <option value="admin">admin</option>
              <option value="developer">developer</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">password</span>
            <input className="input" name="password" type="password" minLength={12} required />
          </label>
          <button className="btn primary" type="submit">
            create account
          </button>
        </form>
      </div>

      <h2 style={{ fontSize: 16, margin: "18px 0 10px" }}>Local accounts</h2>
      <div className="adm-rows">
        {accounts.map((a) => (
          <div key={a.email} className="adm-row">
            <span className="wid">{a.email}</span>
            <span className="detail">{a.role}</span>
            <div className="meta">
              <span>id {a.ownerId}</span>
              <span>created {fmt(a.createdAt)}</span>
              <span>by {a.createdBy}</span>
              {a.disabledAt !== undefined && <span>disabled {fmt(a.disabledAt)}</span>}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16, margin: "18px 0 10px" }}>Sessions</h2>
      <p className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
        {activeSessions.length} active of {sessions.length} total session rows.
      </p>
      <div className="adm-rows">
        {sessions.map((s) => (
          <div key={s.id} className="adm-row">
            <span className="wid">{s.ownerId}</span>
            <span className="detail">{s.revokedAt === undefined ? "active" : "revoked"}</span>
            <form action={revokeUserSessionsAction}>
              <input type="hidden" name="ownerId" value={s.ownerId} />
              <button className="btn" type="submit">
                revoke user
              </button>
            </form>
            <div className="meta">
              <span>role {s.role}</span>
              <span>created {fmt(s.createdAt)}</span>
              <span>refreshed {fmt(s.refreshedAt)}</span>
              <span>expires {fmt(s.expiresAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
