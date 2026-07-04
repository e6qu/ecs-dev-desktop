// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto, WorkspaceStateDto } from "@edd/api-contracts";
import { WORKSPACE_PATH_PREFIX } from "@edd/core";

import { TESTID } from "../lib/testids";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceActions } from "./WorkspaceActions";

const STAGGER_MS = 40;

/** States from which the editor is reachable through the in-app `/w/<id>/` proxy:
 * running/idle serve immediately; a stopped workspace wakes on connect. The other
 * states (provisioning/deleting/terminated/error) have no editor to open. */
const OPENABLE_STATES: ReadonlySet<WorkspaceStateDto> = new Set(["running", "idle", "stopped"]);

export function WorkspaceCard({
  ws,
  index,
  showOwner,
}: {
  /** A workspace DTO already enriched (catalog image fields + ssh command) by the
   * server / `enrichWorkspace`, so the card is a pure renderer. */
  ws: WorkspaceDto;
  index: number;
  showOwner: boolean;
}) {
  const imageName = ws.imageName ?? ws.baseImage;
  const imageDescription = ws.imageDescription ?? "";
  const imageTags = ws.imageTags ?? [];
  const sshCommand = ws.sshCommand;
  // Path-based editor URL served by the control-plane app's in-app proxy.
  const editorHref = `${WORKSPACE_PATH_PREFIX}${ws.id}/`;
  const canOpen = OPENABLE_STATES.has(ws.state);
  return (
    <article
      className="card"
      data-testid={TESTID.workspaceCard}
      data-image={ws.baseImage}
      data-status={ws.state}
      style={{ animationDelay: `${index * STAGGER_MS}ms` }}
    >
      <div className="row">
        <span className="wid">{imageName}</span>
        <StatusBadge state={ws.state} />
        {ws.functional === "degraded" && (
          <span
            className="badge"
            data-status="degraded"
            data-testid={TESTID.workspaceDegraded}
            title="The desktop is running but not fully usable (IDE or workspace storage)."
            aria-label="degraded — running but not fully usable"
          >
            <span className="dot" aria-hidden="true" />
            degraded
          </span>
        )}
      </div>
      <div className="subhead mono">{ws.id}</div>
      <div className="img">{ws.baseImage}</div>
      {imageDescription !== "" && <div className="desc">{imageDescription}</div>}
      {imageTags.length > 0 && (
        <div className="pill-row" style={{ marginTop: 12 }}>
          {imageTags.map((tag) => (
            <span key={tag} className="pill">
              {tag}
            </span>
          ))}
        </div>
      )}
      {showOwner && <div className="owner">owner · {ws.ownerId}</div>}
      {sshCommand !== undefined && (
        <div className="meta-line">
          <span className="meta-label">ssh</span>
          <code
            className="meta-value"
            data-testid={TESTID.workspaceSshCommand}
            data-host={sshCommand}
            style={{ wordBreak: "break-all" }}
          >
            {sshCommand}
          </code>
        </div>
      )}
      {canOpen && (
        <div className="meta-line">
          <a
            className="btn primary"
            href={editorHref}
            data-testid={TESTID.workspaceOpen}
            data-href={editorHref}
          >
            Open editor
          </a>
        </div>
      )}
      <WorkspaceActions id={ws.id} actions={ws.availableActions} />
    </article>
  );
}
