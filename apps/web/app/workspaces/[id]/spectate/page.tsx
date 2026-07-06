// SPDX-License-Identifier: AGPL-3.0-or-later
import { isWorkspaceLabel, workspaceId } from "@edd/core";

import { SpectateViewer } from "../../../../components/SpectateViewer";
import { SignedOutBlock } from "../../../../components/SignedOutBlock";
import { StateBlock } from "../../../../components/StateBlock";
import { getControlPlane } from "../../../../lib/control-plane";
import { getPagePrincipal } from "../../../../lib/principal";

export const dynamic = "force-dynamic";

/**
 * Spectator page: a read-only live mirror of the owner's editor session.
 * Access = signed-in principal with any mapped role (viewer is the floor) AND
 * the owner's share flag ON — the WebSocket upgrade re-enforces both; this
 * shell renders friendly states for the common refusals.
 */
export default async function SpectatePage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await getPagePrincipal();
  const { id } = await params;
  if (principal === null) {
    return <SignedOutBlock detail="Sign in to watch shared sessions." />;
  }
  const detail = isWorkspaceLabel(id)
    ? await (await getControlPlane()).inspect(workspaceId(id))
    : null;
  if (detail?.workspace.shareEnabled !== true) {
    return (
      <StateBlock
        title="Not shared"
        detail="This session is not currently shared by its owner (or does not exist)."
        action={{ href: "/workspaces", label: "back to workspaces" }}
      />
    );
  }
  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">spectate</div>
          <h1 className="mono">{id}</h1>
        </div>
      </div>
      <SpectateViewer id={id} owner={detail.workspace.ownerId} />
    </>
  );
}
