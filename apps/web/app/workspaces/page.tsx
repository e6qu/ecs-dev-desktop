// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";
import { defineAbilityFor } from "@edd/authz";
import { DEPLOY_SHA, DEPLOY_TIME } from "@edd/config";
import Link from "next/link";

import { DeployFooter } from "../../components/DeployFooter";
import { LiveRefresh } from "../../components/LiveRefresh";
import { StateBlock } from "../../components/StateBlock";
import { WorkspaceCard } from "../../components/WorkspaceCard";
import { getCatalog, getControlPlane } from "../../lib/control-plane";
import { getPagePrincipal } from "../../lib/principal";
import { catalogByImage, enrichWorkspace } from "../../lib/workspace-enrich";

export const dynamic = "force-dynamic";

// Keep the workspace list live even when every row currently looks stable: the
// reconciler, another browser tab, or an admin action can stop/delete a workspace
// without this page initiating it. Polling the dynamic server render keeps cards
// from showing stale "running" state after a real shutdown.
// 4s (was 2s): each tick re-runs the dynamic server render — a byOwner query per user, and a
// full-fleet list for the admin all-view — so 2s/tab was needlessly aggressive at 200+ scale.
// Workspace lifecycle changes are minutes-scale, so 4s still converges promptly (rule 13) at
// half the load. LiveRefresh already pauses on hidden tabs.
const WORKSPACE_LIST_REFRESH_MS = 4000;

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
  const canUpdateWorkspace = defineAbilityFor(principal).can("update", "Workspace");
  // Enrich each workspace with its catalog image + ssh command (the same join the
  // API route does), then sort — so the card is a pure renderer of the DTO.
  const byImage = catalogByImage(await getCatalog().list());
  const enriched = raw
    .map((ws) => enrichWorkspace(ws, byImage))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Deleted-but-restorable tombstones render in their own section below the live
  // grid — present (the user can undelete) but never mixed in with active work.
  const workspaces = enriched.filter((w) => w.state !== "terminated");
  const deleted = enriched.filter((w) => w.state === "terminated");

  return (
    <>
      {/* Always mounted — an EMPTY list must converge too: a workspace created
          out-of-band (API, another tab, an admin) has to appear here without a
          hard refresh (AGENTS.md rule 13). */}
      <LiveRefresh intervalMs={WORKSPACE_LIST_REFRESH_MS} />
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
          <nav className="tabs" aria-label="Workspace view">
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
          </nav>
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
            const canMutate = isAdmin || (canUpdateWorkspace && ws.ownerId === principal.id);
            return (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                index={i}
                canShare={ws.ownerId === principal.id}
                canUpdateSettings={canMutate}
                canMutate={canMutate}
              />
            );
          })}
        </div>
      )}

      {deleted.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16 }}>Recently deleted</h2>
          <p className="state-note">
            Deleted sessions stay restorable from their last snapshot for 7 days, then are purged
            for good.
          </p>
          <div className="grid">
            {deleted.map((ws, i) => {
              const canMutate = isAdmin || (canUpdateWorkspace && ws.ownerId === principal.id);
              return (
                <WorkspaceCard
                  key={ws.id}
                  ws={ws}
                  index={i}
                  canUpdateSettings={canMutate}
                  canMutate={canMutate}
                />
              );
            })}
          </div>
        </section>
      )}

      <DeployFooter sha={DEPLOY_SHA} time={DEPLOY_TIME} />
    </>
  );
}
