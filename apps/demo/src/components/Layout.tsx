// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JSX } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { useDemo } from "../lib/use-demo";
import { ResetWidget } from "./ResetWidget";

const navClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? "demo-nav-link active" : "demo-nav-link";

export function Layout(): JSX.Element {
  const cp = useDemo();
  const me = cp.currentUser();
  const isAdmin = me.role === "admin";
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

      <nav className="demo-nav">
        <div className="demo-nav-group">
          <NavLink to="/" end className={navClass}>
            Workspaces
          </NavLink>
          <NavLink to="/catalog" className={navClass}>
            Catalog
          </NavLink>
        </div>
        {isAdmin ? (
          <div className="demo-nav-group">
            <span className="demo-nav-label">admin</span>
            <NavLink to="/admin" end className={navClass}>
              Overview
            </NavLink>
            <NavLink to="/admin/costs" className={navClass}>
              Costs
            </NavLink>
            <NavLink to="/admin/health" className={navClass}>
              Health
            </NavLink>
            <NavLink to="/admin/infra" className={navClass}>
              Infra
            </NavLink>
            <NavLink to="/admin/audit" className={navClass}>
              Audit
            </NavLink>
          </div>
        ) : null}
      </nav>

      <div className="demo-note">
        Client-only showcase — the real <code>@edd/core</code> runs in your browser over
        localStorage ({String(kb)} KB used). Switch identity to <strong>admin</strong> for the admin
        console; “Reset demo” restores fresh seed data.
      </div>

      <main className="demo-main">
        <Outlet />
      </main>
    </div>
  );
}
