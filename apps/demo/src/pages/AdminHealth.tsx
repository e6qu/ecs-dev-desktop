// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { HealthBadge } from "../components/HealthBadge";
import { useDemo } from "../lib/use-demo";

export function AdminHealth(): JSX.Element {
  const cp = useDemo();
  const report = cp.healthReport();

  return (
    <section className="demo-page">
      <div className="demo-page-head">
        <h2>Health</h2>
        <HealthBadge status={report.status} />
      </div>
      <p className="demo-fine">
        Overall status is the worst component (the real <code>summarizeHealth</code> roll-up).
        Compute degrades when a workspace task is in error — try deleting the errored workspace and
        watch it recover.
      </p>
      <ul className="adm-rows">
        {report.components.map((c) => (
          <li key={c.component} className="adm-row">
            <div>
              <code>{c.component}</code>
              {c.detail !== undefined ? <div className="meta">{c.detail}</div> : null}
            </div>
            <HealthBadge status={c.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
