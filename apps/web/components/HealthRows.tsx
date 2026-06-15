// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ComponentHealthDto, HealthStatusDto } from "@edd/api-contracts";

import { TESTID } from "../lib/testids";

/** The overall-status badge + last-checked time, shared by the Health board and
 * the Infrastructure view. */
export function HealthHead({ status, checkedAt }: { status: HealthStatusDto; checkedAt: string }) {
  return (
    <div className="health-head">
      <span className="badge" data-h={status}>
        <span className="dot pulse" />
        {status}
      </span>
      <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>
        checked {new Date(checkedAt).toLocaleTimeString()}
      </span>
    </div>
  );
}

/** The per-component status rows (one `health-row` per dependency). */
export function HealthRows({ components }: { components: readonly ComponentHealthDto[] }) {
  return (
    <div className="health-rows">
      {components.map((c) => (
        <div
          key={c.component}
          className="health-row"
          data-testid={TESTID.healthRow}
          data-component={c.component}
          data-h={c.status}
        >
          <span className="badge" data-h={c.status}>
            <span className="dot" />
            {c.status}
          </span>
          <span className="name">{c.component}</span>
          <span className="detail">{c.detail ?? ""}</span>
        </div>
      ))}
    </div>
  );
}
