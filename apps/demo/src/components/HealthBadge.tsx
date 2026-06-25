// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import type { HealthStatus } from "@edd/core";

export function HealthBadge({ status }: { status: HealthStatus }): JSX.Element {
  return (
    <span className={`h-badge h-${status}`}>
      <span className="h-dot" aria-hidden="true" />
      {status}
    </span>
  );
}
