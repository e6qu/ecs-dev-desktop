// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { ownerId } from "@edd/core";
import Link from "next/link";

import { CreateWorkspace } from "../../components/CreateWorkspace";
import { WorkspaceCard } from "../../components/WorkspaceCard";
import { getCatalog, getControlPlane } from "../../lib/control-plane";
import { getPagePrincipal } from "../../lib/principal";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const principal = await getPagePrincipal();
  if (principal === null) {
    return (
      <div className="empty">
        <div className="big">Not signed in</div>
        <p>Sign in to view and manage your workspaces.</p>
        <p style={{ marginTop: 18 }}>
          <Link className="btn primary" href="/login">
            sign in
          </Link>
        </p>
      </div>
    );
  }

  const { view } = await searchParams;
  const isAdmin = principal.role === "admin";
  const viewAll = view === "all" && isAdmin;

  const cp = await getControlPlane();
  const workspaces: WorkspaceDto[] = viewAll
    ? await cp.list()
    : await cp.list({ ownerId: ownerId(principal.id) });
  workspaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const canCreate = defineAbilityFor(principal).can("create", "Workspace");
  // Launch only from enabled catalog entries (the admin-curated allow-list).
  const options = (await getCatalog().list())
    .filter((entry) => entry.enabled)
    .map((entry) => ({ name: entry.name, image: entry.image }));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">workspaces</div>
          <h1>{viewAll ? "All workspaces" : "Your workspaces"}</h1>
          <p>Provision, snapshot, and scale your cloud dev environments to zero when idle.</p>
        </div>
      </div>

      <div className="toolbar">
        {canCreate ? (
          <CreateWorkspace images={options} />
        ) : (
          <span className="mono" style={{ color: "var(--dim)" }}>
            read-only access
          </span>
        )}
        <span className="spacer" />
        {isAdmin && (
          <div className="tabs">
            <Link className={viewAll ? "" : "on"} href="/workspaces">
              mine
            </Link>
            <Link className={viewAll ? "on" : ""} href="/workspaces?view=all">
              all
            </Link>
          </div>
        )}
      </div>

      {workspaces.length === 0 ? (
        <div className="empty">
          <div className="big">No workspaces yet</div>
          <p>Spin one up from a golden base image to get started.</p>
        </div>
      ) : (
        <div className="grid">
          {workspaces.map((ws, i) => (
            <WorkspaceCard key={ws.id} ws={ws} index={i} showOwner={viewAll} />
          ))}
        </div>
      )}
    </>
  );
}
