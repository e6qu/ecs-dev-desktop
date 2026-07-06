// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WorkspaceDto, WorkspaceStateDto } from "@edd/api-contracts";
import { WORKSPACE_PATH_PREFIX } from "@edd/core";

import { gib } from "../lib/format";
import { TESTID } from "../lib/testids";
import { ShareToggle } from "./ShareToggle";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceActions } from "./WorkspaceActions";
import { WorkspaceInfo } from "./WorkspaceInfo";

const STAGGER_MS = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors DEFAULT_UNDELETE_RETENTION_MS (a UI hint only — the service enforces it). */
const UNDELETE_RETENTION_DAYS = 7;

/** Whole days of the undelete window left, floored at 0 (purge imminent). */
function restoreDaysLeft(terminatedAt: string): number {
  const elapsed = Date.now() - Date.parse(terminatedAt);
  return Math.max(0, Math.ceil(UNDELETE_RETENTION_DAYS - elapsed / DAY_MS));
}

/** States where the editor is reachable NOW through the in-app `/w/<id>/` proxy
 * and "Open editor" links straight to it. A stopped workspace is NOT here: it must
 * wake first, so it gets a single "Resume" button that routes through the status
 * page (which wakes it, shows the load progress, and redirects into the editor when
 * ready) rather than dumping the browser on a blank proxy page during the cold start. */
const READY_STATES: ReadonlySet<WorkspaceStateDto> = new Set(["running", "idle"]);
/** States with meaningful utilization/cost data for the Monitoring link. */
const MONITORABLE_STATES: ReadonlySet<WorkspaceStateDto> = new Set(["running", "idle", "stopped"]);

export function WorkspaceCard({
  ws,
  index,
  showOwner,
  canShare = false,
}: {
  /** A workspace DTO already enriched (catalog image fields + ssh command) by the
   * server / `enrichWorkspace`, so the card is a pure renderer. */
  ws: WorkspaceDto;
  index: number;
  showOwner: boolean;
  /** True only when the VIEWER owns this workspace: the spectate share toggle is
   * strictly an owner control (the route re-enforces it). */
  canShare?: boolean;
}) {
  const imageName = ws.imageName ?? ws.baseImage;
  const imageDescription = ws.imageDescription ?? "";
  const imageTags = ws.imageTags ?? [];
  const sshCommand = ws.sshCommand;
  // Path-based editor URL served by the control-plane app's in-app proxy.
  const editorHref = `${WORKSPACE_PATH_PREFIX}${ws.id}/`;
  const statusHref = `/workspaces/${ws.id}`;
  // Resume routes through the status page with autoopen so the browser watches the
  // wake (progress + logs) and is redirected into the editor once it is ready.
  const resumeHref = `${statusHref}?autoopen=1`;
  const isReady = READY_STATES.has(ws.state);
  const isStopped = ws.state === "stopped";
  // Never render the raw "start" as its own button: on the card a stopped workspace
  // is woken by the single "Resume" affordance (Start + Open in one), so a separate
  // Start button would be a second control doing the same thing.
  const cardActions = ws.availableActions.filter((action) => action !== "start");
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
        <WorkspaceInfo ws={ws} />
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
      {ws.state === "terminated" && ws.terminatedAt !== undefined && (
        <div className="meta-line">
          <span className="meta-label">deleted</span>
          <span className="meta-value mono">
            {new Date(ws.terminatedAt).toLocaleString()} — restorable for{" "}
            {restoreDaysLeft(ws.terminatedAt)} more day(s)
          </span>
        </div>
      )}
      {ws.resources !== undefined && (
        <div className="meta-line">
          <span className="meta-label">size</span>
          <span className="meta-value mono">
            {ws.resources.vcpu} vCPU · {ws.resources.memoryGib} GiB mem ·{" "}
            {ws.diskUsedBytes !== undefined
              ? `disk ${gib(ws.diskUsedBytes)} / ${ws.resources.volumeGib} GiB`
              : `${ws.resources.volumeGib} GiB disk`}
          </span>
        </div>
      )}
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
      <div className="meta-line" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isReady && (
          <a
            className="btn primary"
            href={editorHref}
            data-testid={TESTID.workspaceOpen}
            data-href={editorHref}
          >
            Open editor
          </a>
        )}
        {isStopped && (
          <a
            className="btn primary"
            href={resumeHref}
            data-testid={TESTID.workspaceResume}
            data-href={resumeHref}
          >
            Resume
          </a>
        )}
        {/* A proper status page, linked directly from every card: watch a not-yet-
            loaded workspace come up (phase stepper + live boot logs) and reach the
            editor when ready. Redundant with Resume for a stopped workspace (which
            already routes here), so shown for every OTHER state. */}
        {!isStopped && (
          <a className="btn" href={statusHref} data-testid={TESTID.workspaceStatusLink}>
            Status
          </a>
        )}
        {MONITORABLE_STATES.has(ws.state) && (
          <a
            className="btn"
            href={`/workspaces/${ws.id}/monitoring`}
            data-testid={TESTID.workspaceMonitoringLink}
          >
            Monitoring
          </a>
        )}
      </div>
      {canShare && (isReady || ws.shareEnabled === true) && (
        <ShareToggle id={ws.id} enabled={ws.shareEnabled === true} />
      )}
      {!canShare && ws.shareEnabled === true && (
        <div className="meta-line">
          <a className="btn" href={`/workspaces/${ws.id}/spectate`}>
            Spectate (read-only)
          </a>
        </div>
      )}
      <WorkspaceActions id={ws.id} actions={cardActions} />
    </article>
  );
}
