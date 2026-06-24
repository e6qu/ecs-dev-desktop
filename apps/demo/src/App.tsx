// SPDX-License-Identifier: AGPL-3.0-or-later
import { lazy, Suspense, type JSX } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { useDemo } from "./lib/use-demo";
import { AdminAudit } from "./pages/AdminAudit";
import { AdminCosts } from "./pages/AdminCosts";
import { AdminHealth } from "./pages/AdminHealth";
import { AdminInfra } from "./pages/AdminInfra";
import { AdminOverview } from "./pages/AdminOverview";
import { Catalog } from "./pages/Catalog";
import { Settings } from "./pages/Settings";
import { WorkspaceDetail } from "./pages/WorkspaceDetail";
import { Workspaces } from "./pages/Workspaces";

// The IDE pulls in Monaco (~4 MB) — lazy-load it so only visitors who open the IDE pay for it.
const Ide = lazy(() => import("./pages/Ide").then((m) => ({ default: m.Ide })));

/** Gate the admin routes on the demo identity's role (switch to admin in the header). */
function RequireAdmin({ children }: { children: JSX.Element }): JSX.Element {
  const cp = useDemo();
  return cp.currentUser().role === "admin" ? children : <Navigate to="/" replace />;
}

export function App(): JSX.Element {
  // HashRouter so deep links work on GitHub Pages without server rewrites.
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Workspaces />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="workspace/:id" element={<WorkspaceDetail />} />
          <Route path="settings" element={<Settings />} />
          <Route
            path="ide/:id"
            element={
              <Suspense fallback={<div className="demo-page demo-empty">Loading IDE…</div>}>
                <Ide />
              </Suspense>
            }
          />
          <Route
            path="admin"
            element={
              <RequireAdmin>
                <AdminOverview />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/costs"
            element={
              <RequireAdmin>
                <AdminCosts />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/health"
            element={
              <RequireAdmin>
                <AdminHealth />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/infra"
            element={
              <RequireAdmin>
                <AdminInfra />
              </RequireAdmin>
            }
          />
          <Route
            path="admin/audit"
            element={
              <RequireAdmin>
                <AdminAudit />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
