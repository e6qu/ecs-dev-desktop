// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { relTime } from "../lib/format";
import { useDemo } from "../lib/use-demo";

export function AdminAudit(): JSX.Element {
  const cp = useDemo();
  const events = cp.audit();

  return (
    <section className="demo-page">
      <h2>Audit feed</h2>
      <p className="demo-fine">
        The append-only lifecycle ledger (newest first). On real AWS the same shape is filled from
        CloudTrail <code>LookupEvents</code>; here it’s your local seeded + live history.
      </p>
      <ul className="adm-rows">
        {events.map((e, i) => (
          <li key={`${e.target}-${e.at}-${String(i)}`} className="adm-row">
            <div>
              <code>{e.action}</code> · {e.target}
              <div className="meta">{e.detail}</div>
            </div>
            <span className="meta">
              {e.actor} · {relTime(e.at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
