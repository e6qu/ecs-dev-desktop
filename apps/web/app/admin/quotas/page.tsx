// SPDX-License-Identifier: AGPL-3.0-or-later
import { getQuotaReport } from "../../../lib/quota-report";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

function fmtLimit(limit: number | null): string {
  return limit === null ? "unlimited" : limit.toString();
}

// Admin-only (the /admin layout gates it). Renders the quota report (per-role limits +
// per-user usage) from the shared builder — the same data `GET /api/admin/quotas` serves.
export default async function AdminQuotasPage() {
  const { limits, usage } = await getQuotaReport();

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
        {limits.map(({ role, limit }) => (
          <div key={role} style={{ display: "contents" }}>
            <dt data-testid={TESTID.quotaRow} data-role={role}>
              {role}
            </dt>
            <dd>{fmtLimit(limit)}</dd>
          </div>
        ))}
      </dl>

      <h2 style={{ fontSize: 16, marginBottom: 10 }}>Usage</h2>
      {usage.length === 0 ? (
        <p className="state-note">no workspaces yet</p>
      ) : (
        <div className="adm-rows">
          {usage.map(({ owner, count, role, limit, atOrOver }) => (
            <div
              key={owner}
              className="health-row"
              data-testid={TESTID.quotaUsageRow}
              data-over-limit={atOrOver ? "true" : undefined}
            >
              <span className="name">{owner}</span>
              <span className="detail">
                {role !== undefined
                  ? `${count.toString()} / ${fmtLimit(limit)} (${role})`
                  : `${count.toString()} workspace${count === 1 ? "" : "s"}`}
                {atOrOver ? (
                  <span className="pill" style={{ marginLeft: 8, color: "var(--st-error)" }}>
                    {role !== undefined ? "at/over limit" : "over strictest limit"}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
