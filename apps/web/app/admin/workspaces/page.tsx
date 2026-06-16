// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { StateBlock } from "../../../components/StateBlock";
import { StatusBadge } from "../../../components/StatusBadge";
import { catalogDetailsByImage, lookupCatalogDetails } from "../../../lib/catalog-details";
import { getControlPlane } from "../../../lib/control-plane";
import { getCatalog } from "../../../lib/control-plane";
import { TESTID } from "../../../lib/testids";

export const dynamic = "force-dynamic";

// Admin-only (the /admin layout gates it). Every workspace, newest first.
export default async function AdminWorkspacesPage() {
  const cp = await getControlPlane();
  const [workspaces, catalog] = await Promise.all([cp.list(), getCatalog().list()]);
  const details = catalogDetailsByImage(catalog);
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
        <StateBlock title="No workspaces" detail="Nothing has been provisioned yet." />
      ) : (
        <div className="adm-rows">
          {workspaces.map((ws) => {
            const image = lookupCatalogDetails(details, ws.baseImage);
            return (
              <Link
                key={ws.id}
                href={`/admin/workspaces/${ws.id}`}
                className="adm-row"
                data-testid={TESTID.workspaceRow}
                data-id={ws.id}
                data-status={ws.state}
              >
                <span className="wid">{image.name}</span>
                <StatusBadge state={ws.state} />
                <div className="meta">
                  <span>workspace · {ws.id}</span>
                  <span>image · {ws.baseImage}</span>
                  <span>owner · {ws.ownerId}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
