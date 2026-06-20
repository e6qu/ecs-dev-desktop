// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto } from "@edd/api-contracts";

import { TESTID } from "../lib/testids";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceActions } from "./WorkspaceActions";

const STAGGER_MS = 40;

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
      <WorkspaceActions id={ws.id} actions={ws.availableActions} />
    </article>
  );
}
