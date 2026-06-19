// SPDX-License-Identifier: AGPL-3.0-or-later
import { InfrastructureView } from "../../../components/InfrastructureView";
import { getConfigSyncReport } from "../../../lib/control-plane";

export const dynamic = "force-dynamic";

const GLYPH = { ok: "✓", drift: "✗", unknown: "?" } as const;

async function ConfigSync() {
  const report = await getConfigSyncReport();
  return (
    <section className="card" style={{ marginBottom: "1.5rem" }}>
      <h2>
        Configuration sync{" "}
        <span className={report.inSync ? "status-ok" : "status-bad"}>
          {report.inSync ? "in sync ✓" : "drift ✗"}
        </span>
      </h2>
      <p className="muted">
        Is the running deployment wired the way it should be? Live app-level self-check;
        terraform-plan drift is a separate deploy-time gate.
      </p>
      {report.identity !== undefined && (
        <dl className="iam-identity" data-testid="iam-identity">
          <dt>AWS identity</dt>
          <dd>
            account <code data-field="account">{report.identity.account || "—"}</code>
            {" · "}
            <code data-field="principal" title={report.identity.callerArn}>
              {report.identity.principalArn ?? report.identity.callerArn}
            </code>
          </dd>
        </dl>
      )}
      <ul className="config-sync-checks">
        {report.checks.map((c) => (
          <li key={c.name} data-check={c.name} data-status={c.status}>
            <span title={c.status}>{GLYPH[c.status]}</span> <strong>{c.name}</strong> — {c.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AdminInfrastructurePage() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">operations</div>
          <h1>Infrastructure</h1>
          <p>
            The ECS cluster, dependency status checks, fleet metrics, and the component topology.
            Cluster counts and per-component status light up live (CloudWatch/ECS on AWS).
          </p>
        </div>
      </div>
      <ConfigSync />
      <InfrastructureView />
    </>
  );
}
