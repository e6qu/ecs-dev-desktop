// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ApiClient } from "@edd/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const api = new ApiClient({ baseUrl: "" });

type Pending = "toggle" | "delete" | null;

export function BaseImageActions({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: Exclude<Pending, null>): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      if (action === "toggle") await api.updateBaseImage(id, { enabled: !enabled });
      else await api.deleteBaseImage(id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="foot">
      <button
        type="button"
        className="btn"
        disabled={busy !== null}
        onClick={() => {
          void run("toggle");
        }}
      >
        {busy === "toggle" ? "…" : enabled ? "disable" : "enable"}
      </button>
      <button
        type="button"
        className="btn danger"
        disabled={busy !== null}
        onClick={() => {
          void run("delete");
        }}
      >
        {busy === "delete" ? "…" : "delete"}
      </button>
      {error !== null && (
        <span className="mono" style={{ color: "var(--st-error)", fontSize: 11 }}>
          {error}
        </span>
      )}
    </div>
  );
}
