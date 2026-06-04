// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { StatusBadge } from "../../../components/StatusBadge";
import { getControlPlane } from "../../../lib/control-plane";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). Every workspace, newest first.
export default async function AdminWorkspacesPage() {
  const cp = await getControlPlane();
  const workspaces = await cp.list();
  workspaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">admin</div>
          <h1>All workspaces</h1>
          <p>Every workspace across all users — open one to inspect its state and timeline.</p>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <div className="empty">
          <div className="big">No workspaces</div>
          <p>Nothing has been provisioned yet.</p>
        </div>
      ) : (
        <div className="adm-rows">
          {workspaces.map((ws) => (
            <Link
              key={ws.id}
              href={`/admin/workspaces/${ws.id}`}
              className="adm-row"
              data-testid={TESTID.workspaceRow}
              data-id={ws.id}
              data-status={ws.state}
            >
              <span className="wid">{ws.id}</span>
              <StatusBadge state={ws.state} />
              <div className="meta">
                <span>image · {ws.baseImage}</span>
                <span>owner · {ws.ownerId}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
