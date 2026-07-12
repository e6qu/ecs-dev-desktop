// SPDX-License-Identifier: AGPL-3.0-or-later
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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
import { LiveRefresh, ADMIN_LIST_REFRESH_MS } from "../../../components/LiveRefresh";

export const dynamic = "force-dynamic";

function adminOnly(principal: Awaited<ReturnType<typeof getPagePrincipal>>) {
  if (principal?.role !== "admin") throw new Error("admin required");
  return principal;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Re-render this page with the failure visible (mirrors admin/invitations)
 * instead of crashing the action to the generic error screen. */
function redirectWithError(message: string): never {
  const params = new URLSearchParams();
  params.set("error", message);
  redirect(`/admin/users?${params.toString()}`);
}

async function createAdminAccountAction(formData: FormData): Promise<void> {
  "use server";
  try {
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
  } catch (error) {
    redirectWithError(`create account failed: ${asMessage(error)}`);
  }
}

async function revokeUserSessionsAction(formData: FormData): Promise<void> {
  "use server";
  try {
    adminOnly(await getPagePrincipal());
    await revokeUserSessions(field(formData, "ownerId"));
    revalidatePath("/admin/users");
  } catch (error) {
    redirectWithError(`revoke sessions failed: ${asMessage(error)}`);
  }
}

async function revokeAllSessionsAction(): Promise<void> {
  "use server";
  try {
    adminOnly(await getPagePrincipal());
    await revokeAllSessions();
    revalidatePath("/admin/users");
  } catch (error) {
    redirectWithError(`revoke sessions failed: ${asMessage(error)}`);
  }
}

function fmt(value: string): string {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Cap the reflected query-string message (defensive; mirrors admin/invitations). */
function queryValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.slice(0, 500);
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const principal = await getPagePrincipal();
  if (principal?.role !== "admin") {
    return <StateBlock title="Admins only" detail="The user console requires an administrator." />;
  }
  const error = queryValue((await searchParams).error);
  const [accounts, sessions] = await Promise.all([listLocalAccounts(), listAuthSessions()]);
  const activeSessions = sessions.filter((s) => s.revokedAt === undefined);

  return (
    <>
      <LiveRefresh intervalMs={ADMIN_LIST_REFRESH_MS} />
      {error !== undefined && <StateBlock title="Action failed" detail={error} />}
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
