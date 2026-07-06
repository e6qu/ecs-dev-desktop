// SPDX-License-Identifier: AGPL-3.0-or-later
import { StateBlock } from "../../../../components/StateBlock";
import { WorkspaceMonitoring } from "../../../../components/WorkspaceMonitoring";
import { getPagePrincipal } from "../../../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * Per-workspace monitoring page. Ownership is enforced by the API route the
 * client component polls (GET /api/workspaces/:id/monitoring 403s non-owners),
 * so this server shell only gates on being signed in.
 */
export default async function WorkspaceMonitoringPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await getPagePrincipal();
  const { id } = await params;
  if (principal === null) {
    return (
      <StateBlock
        title="Not signed in"
        detail="Sign in to view workspace monitoring."
        action={{ href: "/login", label: "sign in" }}
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">monitoring</div>
          <h1 className="mono">{id}</h1>
          <p>Utilization, uptime, and cost for this dev desktop — updates every 30 seconds.</p>
        </div>
      </div>
      <WorkspaceMonitoring id={id} />
    </>
  );
}
