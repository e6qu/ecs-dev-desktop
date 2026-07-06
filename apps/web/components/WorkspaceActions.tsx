// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { WorkspaceActionDto } from "@edd/api-contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

const api = new ApiClient({ baseUrl: "" });

function classFor(action: WorkspaceActionDto): string {
  if (action === "start" || action === "undelete") return "btn primary";
  if (action === "delete") return "btn danger";
  return "btn";
}

export function WorkspaceActions({
  id,
  actions,
}: {
  id: string;
  /** The valid actions for this state — server-computed, carried on the DTO. */
  actions: readonly WorkspaceActionDto[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<WorkspaceActionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Delete tears the workspace down (it stays restorable from its retained snapshot
  // for the 7-day undelete window, then is purged for good), so it takes a second
  // click to confirm — a mis-click on the wrong card can't tear down a live session.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function run(action: WorkspaceActionDto): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      switch (action) {
        case "start":
          await api.startWorkspace(id);
          break;
        case "stop":
          await api.stopWorkspace(id);
          break;
        case "snapshot":
          await api.snapshotWorkspace(id);
          break;
        case "delete":
          await api.deleteWorkspace(id);
          break;
        case "undelete":
          await api.undeleteWorkspace(id);
          break;
      }
      router.refresh();
    } catch (e) {
      // Scale-to-zero moves state underneath the user (idle→stopped, stopped→running on
      // wake), so an offered action can 409. Re-sync to the actual state (which updates
      // the offered actions) and show a friendly note instead of just a raw error.
      setError(e instanceof Error ? e.message : "action failed");
      router.refresh();
    } finally {
      setBusy(null);
      setConfirmingDelete(false);
    }
  }

  function onClick(action: WorkspaceActionDto): void {
    if (action === "delete" && !confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    void run(action);
  }

  return (
    <div className="foot">
      {confirmingDelete && busy === null && (
        <span className="sr-only" role="status">
          Click delete again to confirm — the workspace shuts down and stays restorable for 7 days,
          after which its data is purged.
        </span>
      )}
      {actions.map((action) => {
        const isConfirming = action === "delete" && confirmingDelete;
        return (
          <button
            key={action}
            type="button"
            className={classFor(action)}
            disabled={busy !== null}
            aria-label={isConfirming ? "confirm delete — this destroys the workspace data" : action}
            title={
              action === "delete" ? "Deletes the workspace AND its EBS volume/snapshot" : undefined
            }
            onClick={() => {
              onClick(action);
            }}
          >
            {busy === action ? "…" : isConfirming ? "confirm delete" : action}
          </button>
        );
      })}
      {confirmingDelete && busy === null && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setConfirmingDelete(false);
          }}
        >
          cancel
        </button>
      )}
      {error !== null && (
        <span role="alert" className="mono" style={{ color: "var(--st-error)", fontSize: 11 }}>
          {error} — refreshed to the current state.
        </span>
      )}
    </div>
  );
}
