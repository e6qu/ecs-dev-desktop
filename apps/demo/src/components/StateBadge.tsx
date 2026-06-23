// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import type { WorkspaceState } from "@edd/core";

// Reuses the production design system: `.badge` + data-status drives the per-state accent
// colour (--st-running / --st-stopped / …) defined in the shared globals.css.
export function StateBadge({ state }: { state: WorkspaceState }): JSX.Element {
  const pulse = state === "provisioning" || state === "deleting";
  return (
    <span className="badge" data-status={state}>
      <span className={pulse ? "dot pulse" : "dot"} />
      {state}
    </span>
  );
}
