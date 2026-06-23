// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { demo } from "../lib/use-demo";

// UI-only top-right control: wipe the demo's local state and reload to a freshly-seeded site.
// (Phase 2 will also drop the IDE IndexedDB database here.)
export function ResetWidget(): JSX.Element {
  const onReset = (): void => {
    const ok = window.confirm(
      "Reset the demo? This clears all your local changes and reloads with fresh seed data.",
    );
    if (!ok) return;
    demo.reset();
    window.location.reload();
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
