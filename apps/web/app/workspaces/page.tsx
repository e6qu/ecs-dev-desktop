// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { SSH_BASE_DOMAIN } from "@edd/config";
import { isWorkspaceLabel, ownerId, workspacePrincipal, workspaceSshHost } from "@edd/core";
import Link from "next/link";

import { StateBlock } from "../../components/StateBlock";
import { WorkspaceCard } from "../../components/WorkspaceCard";
import { catalogDetailsByImage, lookupCatalogDetails } from "../../lib/catalog-details";
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
  const workspaces: WorkspaceDto[] = viewAll
    ? await cp.list()
    : await cp.list({ ownerId: ownerId(principal.id) });
  workspaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const canCreate = defineAbilityFor(principal).can("create", "Workspace");
  const catalog = await getCatalog().list();
  const details = catalogDetailsByImage(catalog);

  // The per-workspace SSH command, shown only once a deployment has provisioned
  // the SSH subdomain zone (EDD_SSH_BASE_DOMAIN); otherwise there's no address to
  // advertise. Single-gateway routing carries the workspace id in the username.
  const sshCommandFor = (id: string): string | undefined =>
    SSH_BASE_DOMAIN !== "" && isWorkspaceLabel(id)
      ? `ssh ${workspacePrincipal(id)}@${workspaceSshHost(id, SSH_BASE_DOMAIN)}`
      : undefined;

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
        <StateBlock
          title="No workspaces yet"
          detail="Start a session from a curated base image to begin."
          action={canCreate ? { href: "/sessions/new", label: "new session" } : undefined}
        />
      ) : (
        <div className="grid">
          {workspaces.map((ws, i) => {
            const image = lookupCatalogDetails(details, ws.baseImage);
            return (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                index={i}
                showOwner={viewAll}
                imageName={image.name}
                imageDescription={image.description}
                imageTags={image.tags}
                sshCommand={sshCommandFor(ws.id)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
