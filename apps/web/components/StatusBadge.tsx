// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceStateDto } from "@edd/api-contracts";

import { statusMeta } from "../lib/workspace-view";

export function StatusBadge({ state }: { state: WorkspaceStateDto }) {
  const meta = statusMeta(state);
  return (
    <span className="badge" data-status={state}>
      <span className={meta.pulse ? "dot pulse" : "dot"} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
