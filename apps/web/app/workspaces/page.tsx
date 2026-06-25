// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import Link from "next/link";

import { StateBlock } from "../../components/StateBlock";
import { WorkspaceCard } from "../../components/WorkspaceCard";
import { getCatalog, getControlPlane } from "../../lib/control-plane";
import { getPagePrincipal } from "../../lib/principal";
import { catalogByImage, enrichWorkspace } from "../../lib/workspace-enrich";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const principal = await getPagePrincipal();
  if (principal === null) {
    return (
      <StateBlock
        title="Not signed in"
        detail="Sign in to view and manage your workspaces."
        action={{ href: "/login", label: "sign in" }}
      />
    );
  }

  const { view } = await searchParams;
  const isAdmin = principal.role === "admin";
  const viewAll = view === "all" && isAdmin;

  const cp = await getControlPlane();
  const raw: WorkspaceDto[] = viewAll ? await cp.list() : await cp.list({ ownerId: principal.id });

  const canCreate = defineAbilityFor(principal).can("create", "Workspace");
  // Enrich each workspace with its catalog image + ssh command (the same join the
  // API route does), then sort — so the card is a pure renderer of the DTO.
  const byImage = catalogByImage(await getCatalog().list());
  const workspaces = raw
    .map((ws) => enrichWorkspace(ws, byImage))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
          <>
            <Link className="btn primary" href="/sessions/new">
              + new session
            </Link>
            <span className="state-note">
              Pick the environment and repo once in the session launcher.
            </span>
          </>
        ) : (
          <span className="state-note">read-only access</span>
        )}
        <span className="spacer" />
        {isAdmin && (
          <div className="tabs" aria-label="workspace view">
            <Link
              className={viewAll ? "" : "on"}
              href="/workspaces"
              aria-current={viewAll ? undefined : "page"}
            >
              mine
            </Link>
            <Link
              className={viewAll ? "on" : ""}
              href="/workspaces?view=all"
              aria-current={viewAll ? "page" : undefined}
            >
              all
            </Link>
          </div>
        )}
      </div>

      {workspaces.length === 0 ? (
        <StateBlock
          title="No workspaces yet"
          detail="Start a session from a curated base image to begin."
          action={canCreate ? { href: "/sessions/new", label: "new session" } : undefined}
        />
      ) : (
        <div className="grid">
          {workspaces.map((ws, i) => {
            return <WorkspaceCard key={ws.id} ws={ws} index={i} showOwner={viewAll} />;
          })}
        </div>
      )}
    </>
  );
}
