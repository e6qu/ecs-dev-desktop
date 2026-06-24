// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ReactNode } from "react";

import { clearKeys } from "../lib/agent-key";
import { clearAllFiles } from "../lib/ide-files";
import { clearState } from "../lib/persistence";

interface State {
  message: string | null;
}

// Catches any render crash and offers a one-click recovery (wipe local state + reload), so a bad
// or stale persisted blob shows a fix-it screen instead of a blank page.
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  private reset(): void {
    clearState();
    clearKeys();
    // IDE files are in IndexedDB (async) — reload after the wipe resolves.
    void clearAllFiles().finally(() => {
      window.location.reload();
    });
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="demo-crash">
        <h1>The demo hit an error</h1>
        <p>
          This usually means stale local data from an older version. Resetting clears it and reloads
          a fresh demo.
        </p>
        <pre>{this.state.message}</pre>
        <button
          type="button"
          className="demo-primary"
          onClick={() => {
            this.reset();
          }}
        >
          ↺ Reset &amp; reload
        </button>
      </div>
    );
  }
}
