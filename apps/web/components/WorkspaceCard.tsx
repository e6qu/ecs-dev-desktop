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
  ws: WorkspaceDto;
  index: number;
  showOwner: boolean;
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
        <span className="wid">{ws.id}</span>
        <StatusBadge state={ws.state} />
      </div>
      <div className="img">{ws.baseImage}</div>
      {showOwner && <div className="owner">owner · {ws.ownerId}</div>}
      <WorkspaceActions id={ws.id} state={ws.state} />
    </article>
  );
}
