// SPDX-License-Identifier: AGPL-3.0-or-later
import { getControlPlane } from "../../../lib/control-plane";
import { QUOTA_ROLES, workspaceLimit } from "../../../lib/quota";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

function fmtLimit(limit: number | null): string {
  return limit === null ? "unlimited" : limit.toString();
}

// Admin-only (the /admin layout gates it). Per-role limits + per-user usage.
export default async function AdminQuotasPage() {
  const cp = await getControlPlane();
  const workspaces = await cp.list();
  const usage = new Map<string, number>();
  for (const w of workspaces) usage.set(w.ownerId, (usage.get(w.ownerId) ?? 0) + 1);
  const owners = [...usage.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">admin</div>
          <h1>Quotas</h1>
          <p>
            Per-role workspace limits (from config; override per role with
            <span className="mono"> EDD_QUOTA_&lt;ROLE&gt;</span>) and current per-user usage.
          </p>
        </div>
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 10 }}>Limits</h2>
      <dl className="kv" style={{ marginBottom: 28 }}>
        {QUOTA_ROLES.map((role) => (
          <div key={role} style={{ display: "contents" }}>
            <dt data-testid={TESTID.quotaRow} data-role={role}>
              {role}
            </dt>
            <dd>{fmtLimit(workspaceLimit(role))}</dd>
          </div>
        ))}
      </dl>

      <h2 style={{ fontSize: 16, marginBottom: 10 }}>Usage</h2>
      {owners.length === 0 ? (
        <p className="state-note">no workspaces yet</p>
      ) : (
        <div className="adm-rows">
          {owners.map(([owner, n]) => (
            <div key={owner} className="health-row">
              <span className="name">{owner}</span>
              <span className="detail">
                {n.toString()} workspace{n === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
