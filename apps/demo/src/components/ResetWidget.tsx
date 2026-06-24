// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { clearKeys } from "../lib/agent-key";
import { clearAllFiles } from "../lib/ide-files";
import { demo } from "../lib/use-demo";

// UI-only top-right control: wipe ALL of the demo's local state (control plane + IDE files) and
// reload to a freshly-seeded site.
export function ResetWidget(): JSX.Element {
  const onReset = (): void => {
    const ok = window.confirm(
      "Reset the demo? This clears all your local changes and reloads with fresh seed data.",
    );
    if (!ok) return;
    demo.reset();
    clearKeys();
    // IDE files are in IndexedDB (async) — reload only after they're cleared, so the fresh load
    // doesn't race a half-deleted store.
    void clearAllFiles().finally(() => {
      window.location.reload();
    });
  };
  return (
    <button
      type="button"
      className="demo-reset"
      onClick={onReset}
      title="Clear local state and reload a fresh demo"
    >
      ↺ Reset demo
    </button>
  );
}
