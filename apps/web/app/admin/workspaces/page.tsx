// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { StateBlock } from "../../../components/StateBlock";
import { StatusBadge } from "../../../components/StatusBadge";
import { getCatalog, getControlPlane } from "../../../lib/control-plane";
import { TESTID } from "../../../lib/testids";
import { catalogByImage, enrichWorkspace } from "../../../lib/workspace-enrich";

export const dynamic = "force-dynamic";

function snapshotText(at: string | undefined): string {
  return at === undefined ? "never" : new Date(at).toLocaleString();
}

// Admin-only (the /admin layout gates it). Every workspace, newest first.
export default async function AdminWorkspacesPage() {
  const cp = await getControlPlane();
  const [raw, catalog] = await Promise.all([cp.list(), getCatalog().list()]);
  const byImage = catalogByImage(catalog);
  const workspaces = raw
    .map((ws) => enrichWorkspace(ws, byImage))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
        <StateBlock title="No workspaces" detail="Nothing has been provisioned yet." />
      ) : (
        <div className="adm-rows">
          {workspaces.map((ws) => {
            return (
              <Link
                key={ws.id}
                href={`/admin/workspaces/${ws.id}`}
                className="adm-row"
                data-testid={TESTID.workspaceRow}
                data-id={ws.id}
                data-status={ws.state}
              >
                <span className="wid">{ws.imageName ?? ws.baseImage}</span>
                <StatusBadge state={ws.state} />
                <div className="meta">
                  <span>workspace · {ws.id}</span>
                  <span>image · {ws.baseImage}</span>
                  <span>owner · {ws.ownerId}</span>
                  {ws.snapshotIntervalMs !== undefined && (
                    <span>
                      snapshot interval · {String(Math.round(ws.snapshotIntervalMs / 60000))}m
                    </span>
                  )}
                  {ws.diskUsedBytes !== undefined && (
                    <span>
                      disk · {String(Math.round(ws.diskUsedBytes / (1024 * 1024 * 1024)))} GiB used
                    </span>
                  )}
                  <span
                    data-testid={TESTID.workspaceSnapshot}
                    data-snapshot-at={ws.latestSnapshotAt ?? ""}
                  >
                    snapshot · {snapshotText(ws.latestSnapshotAt)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
