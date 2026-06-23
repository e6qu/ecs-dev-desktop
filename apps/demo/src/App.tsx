// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";

import { ResetWidget } from "./components/ResetWidget";
import { useDemo } from "./lib/use-demo";
import { Workspaces } from "./pages/Workspaces";

export function App(): JSX.Element {
  const cp = useDemo();
  const me = cp.currentUser();
  const kb = Math.round(cp.storageBytes() / 1024);

  return (
    <div className="demo-shell">
      <header className="demo-header">
        <div className="demo-brand">
          <span className="demo-logo">◢◤</span>
          <span>
            ecs-dev-desktop <span className="demo-tag">demo</span>
          </span>
        </div>
        <div className="demo-header-right">
          <label className="demo-user">
            <span>acting as</span>
            <select
              value={me.id}
              onChange={(e) => {
                cp.setCurrentUser(e.target.value);
              }}
            >
              {cp.users().map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </label>
          <ResetWidget />
        </div>
      </header>

      <div className="demo-note">
        This is a client-only showcase — the real <code>@edd/core</code> runs in your browser over
        localStorage ({kb} KB used). Nothing leaves your machine; “Reset demo” restores fresh seed
        data.
      </div>

      <main className="demo-main">
        <Workspaces />
      </main>
    </div>
  );
}
