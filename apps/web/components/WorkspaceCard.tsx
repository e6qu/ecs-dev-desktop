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
  imageName,
  imageDescription,
  imageTags,
}: {
  ws: WorkspaceDto;
  index: number;
  showOwner: boolean;
  imageName: string;
  imageDescription: string;
  imageTags: readonly string[];
}) {
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
      <WorkspaceActions id={ws.id} state={ws.state} />
    </article>
  );
}
