// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import type { WorkspaceStateDto } from "@edd/api-contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { availableActions, type WorkspaceAction } from "../lib/workspace-view";

const api = new ApiClient({ baseUrl: "" });

function classFor(action: WorkspaceAction): string {
  if (action === "start") return "btn primary";
  if (action === "delete") return "btn danger";
  return "btn";
}

export function WorkspaceActions({ id, state }: { id: string; state: WorkspaceStateDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState<WorkspaceAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: WorkspaceAction): Promise<void> {
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
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="foot">
      {availableActions(state).map((action) => (
        <button
          key={action}
          type="button"
          className={classFor(action)}
          disabled={busy !== null}
          onClick={() => {
            void run(action);
          }}
        >
          {busy === action ? "…" : action}
        </button>
      ))}
      {error !== null && (
        <span className="mono" style={{ color: "var(--st-error)", fontSize: 11 }}>
          {error}
        </span>
      )}
    </div>
  );
}
